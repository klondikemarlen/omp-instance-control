package linux

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

// CleanupResult reports the outcome of one explicit stale-record cleanup attempt.
type CleanupResult struct {
	InstanceID string `json:"instanceId"`
	Status     string `json:"status"`
	Reason     string `json:"reason"`
}

// CleanupRecords removes only validated records whose process and endpoint are
// both confirmed absent. It never signals an instance or changes its lifecycle.
func (transport *Transport) CleanupRecords() ([]CleanupResult, error) {
	if err := EnsurePrivateDirectory(transport.directory); err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(transport.directory)
	if err != nil {
		return nil, err
	}

	results := make([]CleanupResult, 0)
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		instanceID := strings.TrimSuffix(name, ".json")
		if !validInstanceID(instanceID) {
			results = append(results, CleanupResult{
				InstanceID: instanceID,
				Status:     "failed",
				Reason:     "invalid record filename; file left unchanged",
			})
			continue
		}

		result := transport.cleanupRecord(instanceID)
		if result.InstanceID != "" {
			results = append(results, result)
		}
	}
	return results, nil
}

func (transport *Transport) cleanupRecord(instanceID string) CleanupResult {
	recordFile := filepath.Join(transport.directory, instanceID+".json")
	encoded, record, err := readCleanupRecord(recordFile, transport.scope, instanceID)
	if errors.Is(err, os.ErrNotExist) {
		return CleanupResult{}
	}
	if err != nil {
		return cleanupResult(instanceID, "failed", fmt.Sprintf("record is invalid or unsafe; left unchanged: %v", err))
	}
	if err := requireAbsentProcess(record.PID); err != nil {
		return cleanupResult(instanceID, "preserved", fmt.Sprintf("PID %d is present or cannot be proven absent; record and socket left unchanged: %v", record.PID, err))
	}

	socketFile, err := socketPath(transport.directory, instanceID)
	if err != nil {
		return cleanupResult(instanceID, "failed", fmt.Sprintf("cannot safely inspect the instance endpoint; record left unchanged: %v", err))
	}
	socketInfo, socketExists, err := inspectOwnedRegistrationSocket(socketFile)
	if err != nil {
		return cleanupResult(instanceID, "failed", fmt.Sprintf("instance socket is unsafe; record and socket left unchanged: %v", err))
	}

	if err := requireUnresponsiveEndpoint(socketFile); err != nil {
		return cleanupResult(instanceID, "preserved", fmt.Sprintf("instance endpoint is responsive or could not be safely classified; record and socket left unchanged: %v", err))
	}

	if !cleanupRecordUnchanged(recordFile, transport.scope, instanceID, encoded) {
		return cleanupResult(instanceID, "preserved", "record changed during cleanup; record and socket left unchanged")
	}
	currentSocketInfo, currentSocketExists, err := inspectOwnedRegistrationSocket(socketFile)
	if err != nil {
		return cleanupResult(instanceID, "failed", fmt.Sprintf("instance socket became unsafe; record and socket left unchanged: %v", err))
	}
	if !sameCleanupSocket(socketInfo, socketExists, currentSocketInfo, currentSocketExists) {
		return cleanupResult(instanceID, "preserved", "instance socket changed during cleanup; record and socket left unchanged")
	}

	if socketExists {
		// Recheck the record, endpoint, and socket identity before unlinking the
		// socket. The process check is last so absence is as recent as possible.
		if !cleanupRecordUnchanged(recordFile, transport.scope, instanceID, encoded) {
			return cleanupResult(instanceID, "preserved", "record changed during cleanup; record and socket left unchanged")
		}
		if err := requireUnresponsiveEndpoint(socketFile); err != nil {
			return cleanupResult(instanceID, "preserved", fmt.Sprintf("instance endpoint is responsive or could not be safely classified; record and socket left unchanged: %v", err))
		}
		latestSocketInfo, stillExists, err := inspectOwnedRegistrationSocket(socketFile)
		if err != nil || !sameCleanupSocket(socketInfo, true, latestSocketInfo, stillExists) {
			if err != nil {
				return cleanupResult(instanceID, "failed", fmt.Sprintf("instance socket became unsafe; record and socket left unchanged: %v", err))
			}
			return cleanupResult(instanceID, "preserved", "instance socket changed during cleanup; record and socket left unchanged")
		}
		if err := requireAbsentProcess(record.PID); err != nil {
			return cleanupResult(instanceID, "preserved", fmt.Sprintf("PID %d is present or cannot be proven absent; record and socket left unchanged: %v", record.PID, err))
		}
		if err := os.Remove(socketFile); err != nil && !errors.Is(err, os.ErrNotExist) {
			return cleanupResult(instanceID, "failed", fmt.Sprintf("could not remove stale instance socket; record left unchanged: %v", err))
		}
	}

	// A newly-created endpoint must not be orphaned by removing its record.
	currentSocketInfo, currentSocketExists, err = inspectOwnedRegistrationSocket(socketFile)
	if err != nil {
		return cleanupResult(instanceID, "failed", fmt.Sprintf("instance socket became unsafe; record left unchanged: %v", err))
	}
	if currentSocketExists {
		return cleanupResult(instanceID, "preserved", "instance socket appeared during cleanup; record left unchanged")
	}
	if !cleanupRecordUnchanged(recordFile, transport.scope, instanceID, encoded) {
		return cleanupResult(instanceID, "preserved", "record changed during cleanup; record left unchanged")
	}
	if err := requireUnresponsiveEndpoint(socketFile); err != nil {
		return cleanupResult(instanceID, "preserved", fmt.Sprintf("instance endpoint is responsive or could not be safely classified; record left unchanged: %v", err))
	}
	if err := assertPrivateFile(recordFile); err != nil {
		return cleanupResult(instanceID, "failed", fmt.Sprintf("record became unsafe; left unchanged: %v", err))
	}
	if err := requireAbsentProcess(record.PID); err != nil {
		return cleanupResult(instanceID, "preserved", fmt.Sprintf("PID %d is present or cannot be proven absent; record left unchanged: %v", record.PID, err))
	}
	if err := os.Remove(recordFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return cleanupResult(instanceID, "failed", fmt.Sprintf("could not remove stale instance record: %v", err))
	}
	return cleanupResult(instanceID, "removed", "stale record and endpoint removed")
}

func cleanupResult(instanceID, status, reason string) CleanupResult {
	return CleanupResult{InstanceID: instanceID, Status: status, Reason: reason}
}

func readCleanupRecord(file string, scope protocol.Scope, instanceID string) ([]byte, protocol.Record, error) {
	var encoded json.RawMessage
	if err := ReadPrivateJSON(file, &encoded); err != nil {
		return nil, protocol.Record{}, err
	}
	if err := validateRecordShape(encoded); err != nil {
		return nil, protocol.Record{}, err
	}
	var record protocol.Record
	if err := json.Unmarshal(encoded, &record); err != nil {
		return nil, protocol.Record{}, fmt.Errorf("invalid instance record: %w", err)
	}
	if err := protocol.ValidateRecord(record, scope); err != nil {
		return nil, protocol.Record{}, err
	}
	if record.InstanceID != instanceID {
		return nil, protocol.Record{}, fmt.Errorf("record identity does not match filename %q", instanceID)
	}
	return encoded, record, nil
}

func cleanupRecordUnchanged(file string, scope protocol.Scope, instanceID string, expected []byte) bool {
	current, _, err := readCleanupRecord(file, scope, instanceID)
	return err == nil && bytes.Equal(current, expected)
}

func requireAbsentProcess(pid int) error {
	err := syscall.Kill(pid, 0)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	if err == nil {
		return errors.New("process still exists")
	}
	return fmt.Errorf("cannot confirm process absence: %w", err)
}

func requireUnresponsiveEndpoint(file string) error {
	connection, err := net.DialTimeout("unix", file, requestTimeout)
	if err == nil {
		_ = connection.Close()
		return errors.New("endpoint accepted a connection")
	}
	if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) {
		return nil
	}
	return fmt.Errorf("endpoint error is not a confirmed absence: %w", err)
}

func sameCleanupSocket(original os.FileInfo, originalExists bool, current os.FileInfo, currentExists bool) bool {
	if originalExists != currentExists {
		return false
	}
	return !originalExists || os.SameFile(original, current)
}
