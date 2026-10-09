package cli

import (
	"encoding/json"
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

func (transport *testTransport) Request(record protocol.Record, request protocol.Request) (protocol.Response, error) {
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
			if request.Action != "restart" || request.InstanceID != record.InstanceID {
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
		t.Fatal("ambiguous --all and --instance selection must fail")
	}
	if _, err := RestartInstances(transport, false, ""); err == nil {
		t.Fatal("restart without an explicit target must fail")
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

func TestFormatRowsEscapesTerminalControlsAndPreservesJSONKeys(t *testing.T) {
	record := clientRecord(strings.Repeat("a", 32))
	data := &protocol.Data{
		CWD:             "/workspace\npath\u0085",
		LauncherManaged: true,
		CanRestart:      true,
		LastRestart:     &protocol.Restart{OperationID: "op", PreviousInstanceID: "old"},
	}
	row := Row{Record: &record, Status: "online", Data: data}
	formatted := FormatRows([]Row{row})
	for _, part := range []string{"\\u000apath\\u0085", "launcher=managed canRestart=true", "completed-after-relaunch:op:old"} {
		if !strings.Contains(formatted, part) {
			t.Fatalf("formatted row lacks %q: %s", part, formatted)
		}
	}
	encoded, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &keys); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"record", "status", "data"} {
		if _, exists := keys[key]; !exists {
			t.Fatalf("row JSON omits %q: %s", key, encoded)
		}
	}
}
