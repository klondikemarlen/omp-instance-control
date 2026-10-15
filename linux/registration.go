package linux

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const (
	launchRegistrationPrefix = "registration-"
	launchRegistrationSuffix = ".json"
)

type launchRegistration struct {
	Version    int    `json:"version"`
	Token      string `json:"token"`
	Scope      string `json:"scope"`
	InstanceID string `json:"instanceId"`
	PID        int    `json:"pid"`
}

// cleanupLaunchRegistrations removes only records proved to belong to the child
// that the launcher has already reaped.
func cleanupLaunchRegistrations(launchDir, token string, scope protocol.Scope, childPID int) error {
	if err := EnsurePrivateDirectory(launchDir); err != nil {
		return err
	}
	if !validToken(token) || childPID <= 0 || !validScopeID(scope.ID) {
		return errors.New("Invalid launch registration owner")
	}

	entries, err := os.ReadDir(launchDir)
	if err != nil {
		return err
	}
	var directory string
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, launchRegistrationPrefix) || !strings.HasSuffix(name, launchRegistrationSuffix) {
			continue
		}
		instanceID := strings.TrimSuffix(strings.TrimPrefix(name, launchRegistrationPrefix), launchRegistrationSuffix)
		if !validInstanceID(instanceID) {
			return fmt.Errorf("Invalid launch registration filename: %s", name)
		}

		registrationPath := filepath.Join(launchDir, name)
		var registration launchRegistration
		if err := ReadPrivateJSON(registrationPath, &registration); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return fmt.Errorf("read launch registration handoff: %w", err)
		}
		if registration.Version != protocol.Version || registration.Token != token ||
			registration.Scope != scope.ID || registration.InstanceID != instanceID ||
			registration.PID != childPID {
			return errors.New("Launch registration ownership does not match the reaped child")
		}
		if directory == "" {
			transport, err := NewTransport(scope)
			if err != nil {
				return err
			}
			directory = transport.directory
		}
		if err := cleanupLaunchRegistration(directory, registration); err != nil {
			return err
		}
		var current launchRegistration
		if err := ReadPrivateJSON(registrationPath, &current); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return err
		}
		if current != registration {
			return errors.New("Launch registration handoff changed during cleanup")
		}
		if err := assertPrivateFile(registrationPath); err != nil {
			return err
		}
		if err := os.Remove(registrationPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove launch registration handoff: %w", err)
		}
	}
	return nil
}

func cleanupLaunchRegistration(directory string, registration launchRegistration) error {
	recordPath := filepath.Join(directory, registration.InstanceID+".json")
	socketPath := filepath.Join(directory, registration.InstanceID+".sock")
	recordBytes, recordExists, matchesOwner, err := readOwnedRegistrationRecord(recordPath, registration)
	if err != nil {
		return err
	}
	socketInfo, socketExists, err := inspectOwnedRegistrationSocket(socketPath)
	if err != nil {
		return err
	}
	if !recordExists {
		if !socketExists || !registrationRecordAbsent(recordPath) {
			return nil
		}
		latestSocketInfo, stillExists, err := inspectOwnedRegistrationSocket(socketPath)
		if err != nil {
			return err
		}
		if !stillExists || !os.SameFile(socketInfo, latestSocketInfo) || !registrationRecordAbsent(recordPath) {
			return nil
		}
		if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove owned instance socket: %w", err)
		}
		return nil
	}
	if !matchesOwner {
		return nil
	}

	if !registrationRecordUnchanged(recordPath, registration, recordBytes) {
		return nil
	}
	if socketExists {
		latestSocketInfo, stillExists, err := inspectOwnedRegistrationSocket(socketPath)
		if err != nil {
			return err
		}
		if !stillExists || !os.SameFile(socketInfo, latestSocketInfo) {
			return nil
		}
		if !registrationRecordUnchanged(recordPath, registration, recordBytes) {
			return nil
		}
		if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove owned instance socket: %w", err)
		}
	}

	if !registrationRecordUnchanged(recordPath, registration, recordBytes) {
		return nil
	}
	if err := assertPrivateFile(recordPath); err != nil {
		return err
	}
	if err := os.Remove(recordPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove owned instance record: %w", err)
	}
	return nil
}

func readOwnedRegistrationRecord(file string, registration launchRegistration) ([]byte, bool, bool, error) {
	var encoded json.RawMessage
	if err := ReadPrivateJSON(file, &encoded); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, false, nil
		}
		return nil, false, false, err
	}
	if err := validateRecordShape(encoded); err != nil {
		return nil, true, false, err
	}
	var record protocol.Record
	if err := json.Unmarshal(encoded, &record); err != nil {
		return nil, true, false, err
	}
	if !record.LauncherManaged || record.InstanceID != registration.InstanceID ||
		record.Scope != registration.Scope || record.PID != registration.PID {
		return nil, true, false, nil
	}
	if err := protocol.ValidateRecord(record, protocol.Scope{ID: registration.Scope}); err != nil {
		return nil, true, false, err
	}
	return encoded, true, true, nil
}

func registrationRecordUnchanged(file string, registration launchRegistration, expected []byte) bool {
	current, exists, matchesOwner, err := readOwnedRegistrationRecord(file, registration)
	return err == nil && exists && matchesOwner && bytes.Equal(current, expected)
}

func registrationRecordAbsent(file string) bool {
	var encoded json.RawMessage
	return errors.Is(ReadPrivateJSON(file, &encoded), os.ErrNotExist)
}

func inspectOwnedRegistrationSocket(file string) (os.FileInfo, bool, error) {
	info, err := os.Lstat(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode()&os.ModeSocket == 0 {
		return nil, false, fmt.Errorf("Unsafe instance socket: %s is not a socket", file)
	}
	uid, err := fileOwnerUID(info)
	if err != nil {
		return nil, false, err
	}
	if uid != uint32(os.Getuid()) || info.Mode().Perm()&0o077 != 0 {
		return nil, false, fmt.Errorf("Unsafe instance socket: %s is not private to the current user", file)
	}
	return info, true, nil
}

func validScopeID(value string) bool {
	if len(value) != 16 {
		return false
	}
	for _, character := range value {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return false
		}
	}
	return true
}
