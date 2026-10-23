package cli

import (
	"context"
	"errors"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func clientRecord(instanceID string) protocol.Record {
	return protocol.Record{
		Version:    protocol.Version,
		InstanceID: instanceID,
		Scope:      "scope",
		PID:        10,
		CWD:        "/workspace",
		SessionID:  "session",
		State:      "running",
	}
}

type testTransport struct {
	mu          sync.Mutex
	records     []protocol.Record
	replacement protocol.Record
	readCount   int
	requested   []string
	respond     func(protocol.Record, protocol.Request) (protocol.Response, error)
}

func (transport *testTransport) ReadRecords() ([]protocol.Record, error) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.readCount++
	return append([]protocol.Record(nil), transport.records...), nil
}

func (transport *testTransport) Request(_ context.Context, record protocol.Record, request protocol.Request) (protocol.Response, error) {
	transport.mu.Lock()
	transport.requested = append(transport.requested, record.InstanceID)
	if record.InstanceID == transport.records[0].InstanceID && transport.replacement.InstanceID != "" {
		transport.records = []protocol.Record{transport.replacement}
	}
	respond := transport.respond
	transport.mu.Unlock()
	return respond(record, request)
}

func TestRestartBroadcastUsesOnlyInitialSnapshot(t *testing.T) {
	first := clientRecord(strings.Repeat("a", 32))
	second := clientRecord(strings.Repeat("b", 32))
	replacement := clientRecord(strings.Repeat("c", 32))
	transport := &testTransport{
		records:     []protocol.Record{first, second},
		replacement: replacement,
		respond: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
			if request.Action != "restart-wrapper" || request.InstanceID != record.InstanceID {
				t.Errorf("request did not target its snapshot record: record=%q request=%#v", record.InstanceID, request)
			}
			return protocol.Response{OK: true, Data: &protocol.Data{State: "accepted"}}, nil
		},
	}
	rows, err := RestartInstances(transport, true, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].InstanceID != first.InstanceID || rows[1].InstanceID != second.InstanceID {
		t.Fatalf("broadcast rows did not preserve snapshot ordering: %#v", rows)
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.readCount != 1 {
		t.Fatalf("broadcast reread discovery %d times, want one snapshot", transport.readCount)
	}
	if len(transport.requested) != 2 {
		t.Fatalf("broadcast request count = %d, want 2", len(transport.requested))
	}
	for _, instanceID := range transport.requested {
		if instanceID == replacement.InstanceID {
			t.Fatal("broadcast retargeted a replacement instance")
		}
	}
}

func TestRestartAcceptsUniquePrefixesAndReturnsFullIdentity(t *testing.T) {
	first := clientRecord("123456789" + strings.Repeat("a", 23))
	second := clientRecord("12345678a" + strings.Repeat("b", 23))
	third := clientRecord("abcdef012" + strings.Repeat("c", 23))
	for _, testCase := range []struct {
		name     string
		selector string
		wantID   string
	}{
		{name: "displayed eight-character prefix", selector: "abcdef01", wantID: third.InstanceID},
		{name: "longer prefix", selector: "123456789", wantID: first.InstanceID},
		{name: "full ID", selector: second.InstanceID, wantID: second.InstanceID},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			transport := &testTransport{
				records: []protocol.Record{first, second, third},
				respond: func(record protocol.Record, request protocol.Request) (protocol.Response, error) {
					if request.Action != "restart-wrapper" || request.InstanceID != testCase.wantID || record.InstanceID != testCase.wantID {
						t.Errorf("request did not target the full matching ID: record=%q request=%#v", record.InstanceID, request)
					}
					return protocol.Response{OK: true, Data: &protocol.Data{State: "accepted"}}, nil
				},
			}
			rows, err := RestartInstances(transport, false, testCase.selector)
			if err != nil {
				t.Fatal(err)
			}
			if len(rows) != 1 || rows[0].Status != "accepted" || rows[0].InstanceID != testCase.wantID ||
				rows[0].Record == nil || rows[0].Record.InstanceID != testCase.wantID {
				t.Fatalf("restart result did not retain the full matching ID: %#v", rows)
			}

			transport.mu.Lock()
			defer transport.mu.Unlock()
			if transport.readCount != 1 {
				t.Fatalf("restart reread discovery %d times, want one snapshot", transport.readCount)
			}
			if len(transport.requested) != 1 || transport.requested[0] != testCase.wantID {
				t.Fatalf("restart requests = %q, want only %q", transport.requested, testCase.wantID)
			}
		})
	}
}

func TestRestartAmbiguousPrefixMakesNoRequests(t *testing.T) {
	first := clientRecord("deadbeef0" + strings.Repeat("a", 23))
	stale := clientRecord("deadbeef1" + strings.Repeat("b", 23))
	transport := &testTransport{
		records: []protocol.Record{first, stale},
		respond: func(record protocol.Record, _ protocol.Request) (protocol.Response, error) {
			if record.InstanceID == stale.InstanceID {
				return protocol.Response{}, syscall.ENOENT
			}
			return protocol.Response{OK: true}, nil
		},
	}

	rows, err := RestartInstances(transport, false, "deadbeef")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Status != "failed" || rows[0].InstanceID != "deadbeef" ||
		rows[0].ErrorCode != "AMBIGUOUS_INSTANCE" ||
		rows[0].Error != "Instance ID prefix matches multiple instances; use a longer ID." {
		t.Fatalf("ambiguous prefix result = %#v", rows)
	}

	transport.mu.Lock()
	defer transport.mu.Unlock()
	if transport.readCount != 1 {
		t.Fatalf("ambiguous restart read discovery %d times, want one snapshot", transport.readCount)
	}
	if len(transport.requested) != 0 {
		t.Fatalf("ambiguous restart sent requests for %q", transport.requested)
	}
}

func TestRestartSelectionAndOutcomeClassification(t *testing.T) {
	first := clientRecord(strings.Repeat("a", 32))
	second := clientRecord(strings.Repeat("b", 32))
	transport := &testTransport{
		records: []protocol.Record{first, second},
		respond: func(record protocol.Record, _ protocol.Request) (protocol.Response, error) {
			switch record.InstanceID {
			case first.InstanceID:
				return protocol.Response{Error: &protocol.Error{Code: "NOT_READY", Message: "No persisted session."}}, nil
			case second.InstanceID:
				return protocol.Response{}, errors.New("response timed out; outcome unknown")
			default:
				return protocol.Response{}, syscall.ECONNREFUSED
			}
		},
	}
	rows, err := RestartInstances(transport, true, "")
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Status != "failed" || rows[0].ErrorCode != "NOT_READY" || rows[1].Status != "unknown" {
		t.Fatalf("restart outcomes were not preserved: %#v", rows)
	}

	missing, err := RestartInstances(transport, false, strings.Repeat("c", 32))
	if err != nil || len(missing) != 1 || missing[0].Status != "failed" {
		t.Fatalf("missing selection should return a failed result: rows=%#v err=%v", missing, err)
	}
	if _, err := RestartInstances(transport, true, first.InstanceID); err == nil {
		t.Fatal("ambiguous all and single-instance selection must fail")
	}
	if _, err := RestartInstances(transport, false, ""); err == nil {
		t.Fatal("restart without an explicit target must fail")
	}
}

func TestRestartFailureStillIdentifiesTheProject(t *testing.T) {
	record := clientRecord(strings.Repeat("a", 32))
	record.CWD = "/projects/customer/payments"
	transport := &testTransport{
		records: []protocol.Record{record},
		respond: func(protocol.Record, protocol.Request) (protocol.Response, error) {
			return protocol.Response{}, syscall.ENOENT
		},
	}

	rows, err := RestartInstances(transport, true, "")
	if err != nil {
		t.Fatal(err)
	}

	if text := FormatRows(rows); !strings.Contains(text, "customer/payments") || !strings.Contains(text, "unreachable") {
		t.Fatalf("failed restart lost its identifiable project: %q", text)
	}
}

func TestListDistinguishesUnreachableAndCorrelatedRejection(t *testing.T) {
	first := clientRecord(strings.Repeat("a", 32))
	second := clientRecord(strings.Repeat("b", 32))
	third := clientRecord(strings.Repeat("c", 32))
	transport := &testTransport{
		records: []protocol.Record{first, second, third},
		respond: func(record protocol.Record, _ protocol.Request) (protocol.Response, error) {
			switch record.InstanceID {
			case first.InstanceID:
				return protocol.Response{}, syscall.ENOENT
			case second.InstanceID:
				return protocol.Response{}, syscall.ECONNREFUSED
			default:
				return protocol.Response{Error: &protocol.Error{Code: "INSTANCE_CLOSING", Message: "This instance is shutting down."}}, nil
			}
		},
	}
	rows, err := ListInstances(transport)
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Status != "unreachable" || rows[1].Status != "unreachable" || rows[2].Status != "failed" || rows[2].ErrorCode != "INSTANCE_CLOSING" {
		t.Fatalf("list outcomes were not preserved: %#v", rows)
	}
}

func TestFormatRowsEscapesTerminalControls(t *testing.T) {
	record := clientRecord(strings.Repeat("a", 32))
	data := &protocol.Data{
		CWD:             "/workspace\npath\u0085",
		LauncherManaged: true,
		CanRestart:      true,
		LastRestart:     &protocol.Restart{OperationID: "op", PreviousInstanceID: "old"},
	}
	row := Row{Record: &record, Status: "online", Data: data}
	formatted := FormatRows([]Row{row})
	if !strings.Contains(formatted, "\\u000apath\\u0085") {
		t.Fatalf("terminal control characters were not escaped: %s", formatted)
	}
}
