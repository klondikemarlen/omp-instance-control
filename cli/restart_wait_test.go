package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"syscall"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

type restartWaitTransport struct {
	readRecords func() ([]protocol.Record, error)
	request     func(protocol.Record, protocol.Request) (protocol.Response, error)
}

func (transport restartWaitTransport) ReadRecords() ([]protocol.Record, error) {
	return transport.readRecords()
}

func (transport restartWaitTransport) Request(_ context.Context, record protocol.Record, request protocol.Request) (protocol.Response, error) {
	return transport.request(record, request)
}

func acceptedRestartRow(record protocol.Record, operationID string) Row {
	return Row{
		Record:     &record,
		InstanceID: record.InstanceID,
		Status:     "accepted",
		Data:       &protocol.Data{OperationID: &operationID},
	}
}

func replacementRecord(instanceID string, pid int, operationID, previousInstanceID string) protocol.Record {
	record := clientRecord(instanceID)
	record.PID = pid
	record.LastRestart = &protocol.Restart{
		OperationID:        operationID,
		PreviousInstanceID: previousInstanceID,
	}
	return record
}

func statusResponse(request protocol.Request, data *protocol.Data) protocol.Response {
	return protocol.Response{
		Version:    protocol.Version,
		InstanceID: request.InstanceID,
		RequestID:  request.RequestID,
		OK:         true,
		Data:       data,
	}
}

func TestWaitForRestartsCompletesOnlyAfterCorrelatedReplacementIsLive(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "restart-operation"
	candidate := replacementRecord("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 11, operationID, original.InstanceID)
	liveStatus := &protocol.Data{
		Version:    protocol.Version,
		InstanceID: candidate.InstanceID,
		PID:        candidate.PID,
		State:      "running",
		LastRestart: &protocol.Restart{
			OperationID:        operationID,
			PreviousInstanceID: original.InstanceID,
		},
	}
	acknowledgement := acceptedRestartRow(original, operationID)
	requests := 0
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) {
			return []protocol.Record{candidate}, nil
		},
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			requests++
			if request.Action != "status" || record.InstanceID != candidate.InstanceID {
				t.Fatalf("wait issued a non-candidate status request: record=%q request=%#v", record.InstanceID, request)
			}
			return statusResponse(request, liveStatus), nil
		},
	}
	var progressStatuses []string

	rows, err := WaitForRestarts(context.Background(), transport, []Row{acknowledgement}, func(progress []Row) {
		progressStatuses = append(progressStatuses, progress[0].Status)
	})
	if err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("status probe count = %d, want one live replacement probe", requests)
	}
	if len(rows) != 1 || rows[0].Status != "restarted" || rows[0].InstanceID != original.InstanceID {
		t.Fatalf("restart did not complete against the original target: %#v", rows)
	}
	if rows[0].Data.InstanceID != candidate.InstanceID || rows[0].Data.LastRestart.OperationID != operationID || rows[0].Data.LastRestart.PreviousInstanceID != original.InstanceID {
		t.Fatalf("completion did not retain the correlated live status: %#v", rows[0].Data)
	}
	if len(progressStatuses) != 2 || progressStatuses[0] != "waiting" || progressStatuses[1] != "restarted" {
		t.Fatalf("progress did not report initialization and completion: %#v", progressStatuses)
	}
}

func TestWaitForRestartsDoesNotCompleteOnMismatchedOperation(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "accepted-operation"
	candidate := replacementRecord("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 11, "different-operation", original.InstanceID)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requests := 0
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) {
			return []protocol.Record{original, candidate}, nil
		},
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			requests++
			if request.Action != "status" || record.InstanceID != original.InstanceID {
				t.Fatalf("mismatched candidate was treated as a replacement: record=%q request=%#v", record.InstanceID, request)
			}
			cancel()
			return statusResponse(request, &protocol.Data{InstanceID: original.InstanceID, PID: original.PID, State: "running"}), nil
		},
	}

	rows, err := WaitForRestarts(ctx, transport, []Row{acceptedRestartRow(original, operationID)}, nil)
	if !errors.Is(err, context.Canceled) || len(rows) != 1 || rows[0].Status != "waiting" {
		t.Fatalf("mismatched operation proved completion: rows=%#v err=%v", rows, err)
	}
	if requests != 1 {
		t.Fatalf("wait issued %d requests, want only the original status probe", requests)
	}
}

func TestWaitForRestartsDoesNotCompleteOnMismatchedPreviousInstance(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "accepted-operation"
	candidate := replacementRecord("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 11, operationID, "cccccccccccccccccccccccccccccccc")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) {
			return []protocol.Record{original, candidate}, nil
		},
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			if request.Action != "status" || record.InstanceID != original.InstanceID {
				t.Fatalf("candidate with a mismatched previous ID was probed: record=%q request=%#v", record.InstanceID, request)
			}
			cancel()
			return statusResponse(request, &protocol.Data{InstanceID: original.InstanceID, PID: original.PID, State: "running"}), nil
		},
	}

	rows, err := WaitForRestarts(ctx, transport, []Row{acceptedRestartRow(original, operationID)}, nil)
	if !errors.Is(err, context.Canceled) || rows[0].Status != "waiting" {
		t.Fatalf("mismatched previous instance proved completion: rows=%#v err=%v", rows, err)
	}
}

func TestWaitForRestartsAcceptsCorrelatedReplacementWithReusedPID(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "accepted-operation"
	candidate := replacementRecord("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", original.PID, operationID, original.InstanceID)
	liveStatus := &protocol.Data{
		InstanceID: candidate.InstanceID,
		PID:        candidate.PID,
		LastRestart: &protocol.Restart{
			OperationID:        operationID,
			PreviousInstanceID: original.InstanceID,
		},
	}
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) {
			return []protocol.Record{original, candidate}, nil
		},
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			if record.InstanceID != candidate.InstanceID || request.Action != "status" {
				t.Fatalf("same-PID replacement was not status-probed: record=%q request=%#v", record.InstanceID, request)
			}
			return statusResponse(request, liveStatus), nil
		},
	}

	rows, err := WaitForRestarts(context.Background(), transport, []Row{acceptedRestartRow(original, operationID)}, nil)
	if err != nil || len(rows) != 1 || rows[0].Status != "restarted" || rows[0].Data.InstanceID != candidate.InstanceID {
		t.Fatalf("matching replacement with reused PID was not accepted: rows=%#v err=%v", rows, err)
	}
}

func TestWaitForRestartsRejectsMismatchedLiveRestartMetadata(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "accepted-operation"
	candidate := replacementRecord("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 11, operationID, original.InstanceID)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) {
			return []protocol.Record{candidate}, nil
		},
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			if request.Action != "status" || record.InstanceID != candidate.InstanceID {
				t.Fatalf("candidate was not status-probed: record=%q request=%#v", record.InstanceID, request)
			}
			cancel()
			return statusResponse(request, &protocol.Data{
				InstanceID: candidate.InstanceID,
				PID:        candidate.PID,
				LastRestart: &protocol.Restart{
					OperationID:        operationID,
					PreviousInstanceID: "cccccccccccccccccccccccccccccccc",
				},
			}), nil
		},
	}

	rows, err := WaitForRestarts(ctx, transport, []Row{acceptedRestartRow(original, operationID)}, nil)
	if !errors.Is(err, context.Canceled) || rows[0].Status != "unknown" {
		t.Fatalf("mismatched live restart metadata was not kept from success: rows=%#v err=%v", rows, err)
	}
}

func TestWaitForRestartsKeepsWaitingForADeadReplacement(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "accepted-operation"
	candidate := replacementRecord("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 11, operationID, original.InstanceID)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requests := 0
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) {
			return []protocol.Record{candidate}, nil
		},
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			requests++
			if request.Action != "status" || record.InstanceID != candidate.InstanceID {
				t.Fatalf("dead replacement was not status-probed: record=%q request=%#v", record.InstanceID, request)
			}
			cancel()
			return protocol.Response{}, syscall.ENOENT
		},
	}

	rows, err := WaitForRestarts(ctx, transport, []Row{acceptedRestartRow(original, operationID)}, nil)
	if !errors.Is(err, context.Canceled) || len(rows) != 1 || rows[0].Status != "restarting" {
		t.Fatalf("dead replacement was reported complete or failed: rows=%#v err=%v", rows, err)
	}
	if requests != 1 {
		t.Fatalf("status probe count = %d, want one", requests)
	}
}

func TestWaitForRestartsReportsEndpointGapAndBusyWaiting(t *testing.T) {
	t.Run("endpoint gap", func(t *testing.T) {
		original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
		operationID := "accepted-operation"
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		transport := restartWaitTransport{
			readRecords: func() ([]protocol.Record, error) { return nil, nil },
			request: func(protocol.Record, protocol.Request) (protocol.Response, error) {
				t.Fatal("endpoint gap should not trigger a request")
				return protocol.Response{}, nil
			},
		}
		var progressStatuses []string
		rows, err := WaitForRestarts(ctx, transport, []Row{acceptedRestartRow(original, operationID)}, func(progress []Row) {
			progressStatuses = append(progressStatuses, progress[0].Status)
			if progress[0].Status == "restarting" {
				cancel()
			}
		})
		if !errors.Is(err, context.Canceled) || rows[0].Status != "restarting" {
			t.Fatalf("endpoint gap was not reported as restarting: rows=%#v err=%v", rows, err)
		}
		if len(progressStatuses) != 2 || progressStatuses[0] != "waiting" || progressStatuses[1] != "restarting" {
			t.Fatalf("endpoint gap progress was not reported: %#v", progressStatuses)
		}
	})

	t.Run("busy original", func(t *testing.T) {
		original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
		operationID := "accepted-operation"
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		transport := restartWaitTransport{
			readRecords: func() ([]protocol.Record, error) { return []protocol.Record{original}, nil },
			request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
				if request.Action != "status" || record.InstanceID != original.InstanceID {
					t.Fatalf("busy wait sent unexpected request: record=%q request=%#v", record.InstanceID, request)
				}
				cancel()
				return statusResponse(request, &protocol.Data{InstanceID: original.InstanceID, PID: original.PID, State: "running"}), nil
			},
		}
		rows, err := WaitForRestarts(ctx, transport, []Row{acceptedRestartRow(original, operationID)}, nil)
		if !errors.Is(err, context.Canceled) || rows[0].Status != "waiting" {
			t.Fatalf("live original did not remain waiting: rows=%#v err=%v", rows, err)
		}
	})
}

func TestWaitForRestartsTreatsClosingSourceAsTransient(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "accepted-operation"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) { return []protocol.Record{original}, nil },
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			cancel()
			return protocol.Response{
				Version:    protocol.Version,
				InstanceID: request.InstanceID,
				RequestID:  request.RequestID,
				Error:      &protocol.Error{Code: "INSTANCE_CLOSING", Message: "closing"},
			}, nil
		},
	}

	rows, err := WaitForRestarts(ctx, transport, []Row{acceptedRestartRow(original, operationID)}, nil)
	if !errors.Is(err, context.Canceled) || rows[0].Status != "restarting" {
		t.Fatalf("closing original was not a transient restarting phase: rows=%#v err=%v", rows, err)
	}
}

func TestWaitForRestartsTreatsClosingStatusConnectionsAsTransient(t *testing.T) {
	for _, testCase := range []struct {
		name string
		err  error
	}{
		{name: "connection reset", err: syscall.ECONNRESET},
		{name: "broken pipe", err: syscall.EPIPE},
		{name: "peer closed", err: io.EOF},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			transport := restartWaitTransport{
				readRecords: func() ([]protocol.Record, error) {
					return []protocol.Record{original}, nil
				},
				request: func(protocol.Record, protocol.Request) (protocol.Response, error) {
					return protocol.Response{}, fmt.Errorf("status connection closed: %w", testCase.err)
				},
			}

			rows, err := WaitForRestarts(ctx, transport, []Row{acceptedRestartRow(original, "operation")}, func(progress []Row) {
				if progress[0].Status == "restarting" {
					cancel()
				}
			})
			if !errors.Is(err, context.Canceled) || rows[0].Status != "restarting" {
				t.Fatalf("closing status connection must stay pending, got rows=%#v err=%v", rows, err)
			}
		})
	}
}

func TestWaitForRestartsPreservesPeerFailuresAndNeverReplaysRestart(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "accepted-operation"
	failure := Row{
		InstanceID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Status:     "failed",
		Error:      "request rejected",
		ErrorCode:  "NOT_READY",
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requests := 0
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) { return []protocol.Record{original}, nil },
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			requests++
			if request.Action != "status" || record.InstanceID != original.InstanceID {
				t.Fatalf("wait replayed or retargeted a host request: record=%q request=%#v", record.InstanceID, request)
			}
			cancel()
			return statusResponse(request, &protocol.Data{InstanceID: original.InstanceID, PID: original.PID, State: "running"}), nil
		},
	}

	rows, err := WaitForRestarts(ctx, transport, []Row{failure, acceptedRestartRow(original, operationID)}, nil)
	if !errors.Is(err, context.Canceled) || len(rows) != 2 {
		t.Fatalf("wait did not return current outcomes on cancellation: rows=%#v err=%v", rows, err)
	}
	if rows[0].Status != failure.Status || rows[0].Error != failure.Error || rows[0].ErrorCode != failure.ErrorCode {
		t.Fatalf("peer request failure was not preserved: %#v", rows[0])
	}
	if rows[1].Status != "waiting" || rows[1].InstanceID != original.InstanceID {
		t.Fatalf("accepted peer did not retain its pending state: %#v", rows[1])
	}
	if requests != 1 {
		t.Fatalf("wait request count = %d, want one status request and no restart replay", requests)
	}
}

func TestWaitForRestartsMissingOperationIDBecomesUnknown(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) {
			t.Fatal("unknown acknowledgement must not be polled")
			return nil, nil
		},
		request: func(protocol.Record, protocol.Request) (protocol.Response, error) {
			t.Fatal("unknown acknowledgement must not trigger a request")
			return protocol.Response{}, nil
		},
	}
	rows, err := WaitForRestarts(context.Background(), transport, []Row{{
		Record:     &original,
		InstanceID: original.InstanceID,
		Status:     "accepted",
		Data:       &protocol.Data{},
	}}, nil)
	if err != nil || len(rows) != 1 || rows[0].Status != "unknown" || rows[0].Error == "" {
		t.Fatalf("missing operation ID was not reported truthfully: rows=%#v err=%v", rows, err)
	}
}

func TestWaitForRestartsWaitsForCooperativeContinuation(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "restart-operation"
	candidate := replacementRecord("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 11, operationID, original.InstanceID)
	probes := 0
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) {
			return []protocol.Record{candidate}, nil
		},
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			if record.InstanceID != candidate.InstanceID || request.Action != "status" {
				t.Fatalf("unexpected restart observation request: record=%q action=%q", record.InstanceID, request.Action)
			}
			probes++
			phase := "resuming"
			var resumedAt *int64
			if probes == 2 {
				phase = "resumed"
				value := int64(200)
				resumedAt = &value
			}
			return statusResponse(request, &protocol.Data{
				InstanceID: candidate.InstanceID,
				PID:        candidate.PID,
				LastRestart: &protocol.Restart{
					OperationID:        operationID,
					PreviousInstanceID: original.InstanceID,
				},
				Cooperative: &protocol.CooperativeRestart{
					OperationID: operationID,
					Phase:       phase,
					Message:     "Continuation status.",
					RequestedAt: 100,
					ResumedAt:   resumedAt,
				},
			}), nil
		},
	}
	var progressStatuses []string

	rows, err := WaitForRestarts(context.Background(), transport, []Row{acceptedRestartRow(original, operationID)}, func(rows []Row) {
		progressStatuses = append(progressStatuses, rows[0].Status)
	})
	if err != nil {
		t.Fatal(err)
	}
	if probes != 2 || len(rows) != 1 || rows[0].Status != "restarted" {
		t.Fatalf("observer completed before continuation was submitted: probes=%d rows=%#v", probes, rows)
	}
	if rows[0].Data.Cooperative == nil || rows[0].Data.Cooperative.Phase != "resumed" {
		t.Fatalf("completion did not retain resumed metadata: %#v", rows[0].Data)
	}
	if len(progressStatuses) != 3 || progressStatuses[1] != "restarting" || progressStatuses[2] != "restarted" {
		t.Fatalf("progress statuses = %#v", progressStatuses)
	}
}

func TestWaitForRestartsReportsCooperativeBlock(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "restart-operation"
	requests := 0
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) {
			return []protocol.Record{original}, nil
		},
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			requests++
			if record.InstanceID != original.InstanceID || request.Action != "status" {
				t.Fatalf("unexpected blocked status request: record=%q action=%q", record.InstanceID, request.Action)
			}
			return statusResponse(request, &protocol.Data{
				InstanceID: original.InstanceID,
				Cooperative: &protocol.CooperativeRestart{
					OperationID: operationID,
					Phase:       "blocked",
					Message:     "Unsafe background job remains active.",
					RequestedAt: 100,
				},
			}), nil
		},
	}
	rows, err := WaitForRestarts(context.Background(), transport, []Row{acceptedRestartRow(original, operationID)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 1 || len(rows) != 1 || rows[0].Status != "blocked" {
		t.Fatalf("blocked operation was not terminal to the observer: requests=%d rows=%#v", requests, rows)
	}
	if rows[0].Error != "Unsafe background job remains active." {
		t.Fatalf("blocked reason = %q", rows[0].Error)
	}
}

func TestWaitForRestartsReportsOnlyCooperativeTransitions(t *testing.T) {
	original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	operationID := "restart-operation"
	candidate := replacementRecord("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 11, operationID, original.InstanceID)
	reads := 0
	transport := restartWaitTransport{
		readRecords: func() ([]protocol.Record, error) {
			reads++
			if reads <= 2 {
				return []protocol.Record{original}, nil
			}
			return []protocol.Record{candidate}, nil
		},
		request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			phase := "preparing"
			if record.InstanceID == candidate.InstanceID {
				phase = "resumed"
			}
			return statusResponse(request, &protocol.Data{
				InstanceID:  record.InstanceID,
				PID:         record.PID,
				LastRestart: record.LastRestart,
				Cooperative: &protocol.CooperativeRestart{
					OperationID: operationID,
					Phase:       phase,
					Message:     "Checkpoint progress.",
					RequestedAt: 100,
				},
			}), nil
		},
	}
	var phases []string

	_, err := WaitForRestarts(context.Background(), transport, []Row{acceptedRestartRow(original, operationID)}, func(rows []Row) {
		phase := "accepted"
		if rows[0].Data.Cooperative != nil {
			phase = rows[0].Data.Cooperative.Phase
		}
		phases = append(phases, phase)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(phases) != 3 || phases[0] != "accepted" || phases[1] != "preparing" || phases[2] != "resumed" {
		t.Fatalf("progress did not retain only preparation transitions: %#v", phases)
	}
}

func TestCooperativeReplacementWaitsThroughMissingStartupProgress(t *testing.T) {
	for _, finalPhase := range []string{"resumed", "blocked"} {
		t.Run(finalPhase, func(t *testing.T) {
			original := clientRecord("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
			operationID := "restart-operation"
			candidate := replacementRecord("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 11, operationID, original.InstanceID)
			accepted := acceptedRestartRow(original, operationID)
			accepted.Data.Cooperative = &protocol.CooperativeRestart{OperationID: operationID, Phase: "preparing"}
			probes := 0
			transport := restartWaitTransport{
				readRecords: func() ([]protocol.Record, error) { return []protocol.Record{candidate}, nil },
				request: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
					probes++
					data := &protocol.Data{
						InstanceID:  candidate.InstanceID,
						PID:         candidate.PID,
						LastRestart: &protocol.Restart{OperationID: operationID, PreviousInstanceID: original.InstanceID},
					}
					if probes > 1 {
						phase := "resuming"
						if probes > 2 {
							phase = finalPhase
						}
						data.Cooperative = &protocol.CooperativeRestart{OperationID: operationID, Phase: phase}
					}
					return statusResponse(request, data), nil
				},
			}
			rows, err := WaitForRestarts(context.Background(), transport, []Row{accepted}, nil)
			if err != nil {
				t.Fatal(err)
			}
			wantStatus := "restarted"
			if finalPhase == "blocked" {
				wantStatus = "blocked"
			}
			if probes != 3 || rows[0].Status != wantStatus || rows[0].Data.Cooperative.Phase != finalPhase {
				t.Fatalf("startup status bypassed continuation: probes=%d rows=%#v", probes, rows)
			}
		})
	}
}
