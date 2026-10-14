package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"syscall"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const restartPollInterval = 250 * time.Millisecond

// WaitForRestarts observes accepted restart requests until their correlated replacement is live.
// Progress callbacks borrow read-only rows synchronously; they must not retain or mutate them.
func WaitForRestarts(ctx context.Context, transport Transport, rows []Row, progress func([]Row)) ([]Row, error) {
	current := append([]Row(nil), rows...)
	for index := range current {
		if current[index].Status != "accepted" {
			continue
		}
		prepareAcceptedRestart(&current[index])
	}
	notifyRestartProgress(progress, current)
	if err := ctx.Err(); err != nil {
		return current, err
	}
	if !hasPendingRestart(current) {
		return current, nil
	}

	ticker := time.NewTicker(restartPollInterval)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return current, err
		}

		records, err := transport.ReadRecords()
		if contextErr := ctx.Err(); contextErr != nil {
			return current, contextErr
		}
		changed := false
		if err != nil {
			for index := range current {
				if isPendingRestart(current[index]) {
					setRestartUnknown(&current[index], fmt.Errorf("read replacement instances: %w", err))
					changed = true
				}
			}
		} else {
			snapshot := indexRestartRecords(records)
			for index := range current {
				if !isPendingRestart(current[index]) {
					continue
				}
				updated := observeRestart(ctx, transport, current[index], snapshot)
				if restartRowChanged(current[index], updated) {
					current[index] = updated
					changed = true
				}
				if contextErr := ctx.Err(); contextErr != nil {
					if changed {
						notifyRestartProgress(progress, current)
					}
					return current, contextErr
				}
			}
		}
		if changed {
			notifyRestartProgress(progress, current)
		}
		if err := ctx.Err(); err != nil {
			return current, err
		}
		if !hasPendingRestart(current) {
			return current, nil
		}

		select {
		case <-ctx.Done():
			return current, ctx.Err()
		case <-ticker.C:
		}
	}
}

func prepareAcceptedRestart(row *Row) {
	if row.InstanceID == "" && row.Record != nil {
		row.InstanceID = row.Record.InstanceID
	}
	if row.Data == nil || row.Data.OperationID == nil || *row.Data.OperationID == "" {
		setRestartUnknown(row, errors.New("restart acknowledgement did not include an operation ID"))
		return
	}
	if row.InstanceID == "" || row.Record == nil || row.Record.InstanceID != row.InstanceID || row.Record.PID <= 0 {
		setRestartUnknown(row, errors.New("restart result did not retain the original instance record"))
		return
	}
	row.Status = "waiting"
}

func hasPendingRestart(rows []Row) bool {
	for _, row := range rows {
		if isPendingRestart(row) {
			return true
		}
	}
	return false
}

func isPendingRestart(row Row) bool {
	return row.Status == "waiting" || row.Status == "restarting"
}

type restartCorrelation struct {
	operationID        string
	previousInstanceID string
}

type restartSnapshot struct {
	byInstanceID map[string]protocol.Record
	replacements map[restartCorrelation][]protocol.Record
}

func indexRestartRecords(records []protocol.Record) restartSnapshot {
	snapshot := restartSnapshot{
		byInstanceID: make(map[string]protocol.Record, len(records)),
		replacements: make(map[restartCorrelation][]protocol.Record),
	}
	for _, record := range records {
		snapshot.byInstanceID[record.InstanceID] = record
		if record.LastRestart == nil {
			continue
		}
		correlation := restartCorrelation{
			operationID:        record.LastRestart.OperationID,
			previousInstanceID: record.LastRestart.PreviousInstanceID,
		}
		snapshot.replacements[correlation] = append(snapshot.replacements[correlation], record)
	}
	return snapshot
}

func observeRestart(ctx context.Context, transport Transport, row Row, snapshot restartSnapshot) Row {
	operationID := *row.Data.OperationID
	source, originalDiscovered := snapshot.byInstanceID[row.InstanceID]
	if originalDiscovered {
		row.Status = "waiting"
	} else {
		row.Status = "restarting"
	}
	candidates := snapshot.replacements[restartCorrelation{
		operationID:        operationID,
		previousInstanceID: row.InstanceID,
	}]
	var candidateError error

	for _, record := range candidates {
		if !isRestartCandidate(record, row.InstanceID, operationID) {
			continue
		}

		response, err := requestStatus(ctx, transport, record)
		if err != nil {
			if ctx.Err() != nil {
				return row
			}
			if isInstanceDisappearing(err) {
				continue
			}
			candidateError = fmt.Errorf("probe replacement %s: %w", record.InstanceID, err)
			continue
		}
		if !response.OK {
			if response.Error != nil && response.Error.Code == "INSTANCE_CLOSING" {
				continue
			}
			candidateError = fmt.Errorf("probe replacement %s: %s", record.InstanceID, responseError(response))
			continue
		}
		if !liveReplacementMatches(response.Data, record, row.InstanceID, operationID) {
			candidateError = fmt.Errorf("probe replacement %s: live status did not match its discovered restart record", record.InstanceID)
			continue
		}
		row.Status = "restarted"
		row.Data = response.Data
		row.Error = ""
		row.ErrorCode = ""
		return row
	}

	if candidateError != nil {
		setRestartUnknown(&row, candidateError)
		return row
	}
	if !originalDiscovered {
		row.Status = "restarting"
		return row
	}

	response, err := requestStatus(ctx, transport, source)
	if err != nil {
		if ctx.Err() != nil {
			return row
		}
		if isInstanceDisappearing(err) {
			row.Status = "restarting"
			return row
		}
		setRestartUnknown(&row, fmt.Errorf("probe original instance: %w", err))
		return row
	}
	if !response.OK {
		if response.Error != nil && response.Error.Code == "INSTANCE_CLOSING" {
			row.Status = "restarting"
			return row
		}
		setRestartUnknown(&row, fmt.Errorf("probe original instance: %s", responseError(response)))
		return row
	}
	if response.Data == nil || response.Data.InstanceID != row.InstanceID {
		setRestartUnknown(&row, errors.New("probe original instance: status did not match the original identity"))
		return row
	}
	row.Status = "waiting"
	return row
}

func isRestartCandidate(candidate protocol.Record, originalInstanceID, operationID string) bool {
	if candidate.InstanceID == originalInstanceID || candidate.PID <= 0 {
		return false
	}
	if candidate.LastRestart == nil {
		return false
	}
	return candidate.LastRestart.OperationID == operationID && candidate.LastRestart.PreviousInstanceID == originalInstanceID
}

func liveReplacementMatches(data *protocol.Data, candidate protocol.Record, originalInstanceID, operationID string) bool {
	if data == nil || data.InstanceID != candidate.InstanceID || data.PID != candidate.PID || candidate.PID <= 0 {
		return false
	}
	if data.LastRestart == nil {
		return false
	}
	return data.LastRestart.OperationID == operationID && data.LastRestart.PreviousInstanceID == originalInstanceID
}

func requestStatus(ctx context.Context, transport Transport, record protocol.Record) (protocol.Response, error) {
	request, err := protocol.CreateRequest(record.InstanceID, "status")
	if err != nil {
		return protocol.Response{}, err
	}
	return transport.Request(ctx, record, request)
}

func responseError(response protocol.Response) string {
	if response.Error == nil {
		return "status request was rejected without an error"
	}
	if response.Error.Message != "" {
		return response.Error.Message
	}
	return response.Error.Code
}

func isInstanceDisappearing(err error) bool {
	return errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) || errors.Is(err, io.EOF)
}

func setRestartUnknown(row *Row, err error) {
	row.Status = "unknown"
	row.Error = err.Error()
	row.ErrorCode = ""
}

func restartRowChanged(before, after Row) bool {
	return before.Status != after.Status || before.Error != after.Error || before.ErrorCode != after.ErrorCode || before.Data != after.Data
}

func notifyRestartProgress(progress func([]Row), rows []Row) {
	if progress != nil {
		progress(rows)
	}
}
