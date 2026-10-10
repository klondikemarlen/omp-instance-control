package linux

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/cli"
	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const testInstanceID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func testTransport(t *testing.T) (*Transport, protocol.Scope) {
	t.Helper()
	root, err := os.MkdirTemp("", "t-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Setenv("XDG_RUNTIME_DIR", root)
	scope := protocol.Scope{ID: "scope-identity"}
	transport, err := NewTransport(scope)
	if err != nil {
		t.Fatal(err)
	}
	return transport, scope
}

func testRecord(scope protocol.Scope, instanceID string) protocol.Record {
	return protocol.Record{
		Version:         protocol.Version,
		InstanceID:      instanceID,
		Scope:           scope.ID,
		PID:             os.Getpid(),
		CWD:             "/workspace",
		SessionID:       "session-1",
		SessionFile:     stringPointer("/sessions/session-1.jsonl"),
		LauncherManaged: true,
		State:           "running",
		LastRestart:     nil,
		OperationID:     nil,
	}
}

func stringPointer(value string) *string { return &value }

func TestSocketPathEnforcesUnixPathByteLimit(t *testing.T) {
	suffixLength := 1 + len(testInstanceID) + len(".sock")
	for _, pathLength := range []int{107, 108} {
		directory := strings.Repeat("d", pathLength-suffixLength)
		path, err := socketPath(directory, testInstanceID)
		if pathLength == 107 && (err != nil || len(path) != pathLength) {
			t.Fatalf("107-byte socket path should be accepted: path=%q err=%v", path, err)
		}
		if pathLength == 108 && err == nil {
			t.Fatalf("108-byte socket path should be rejected: %q", path)
		}
	}
}

func TestRuntimeRootAndPrivateDirectoryValidation(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "relative-runtime")
	if _, err := RuntimeRoot(); err == nil {
		t.Fatal("relative XDG_RUNTIME_DIR must be rejected")
	}
	t.Setenv("XDG_RUNTIME_DIR", "")
	root, err := RuntimeRoot()
	if err != nil {
		t.Fatal(err)
	}
	if root != filepath.Join("/tmp", fmt.Sprintf("omp-instance-control-%d", os.Getuid())) {
		t.Fatalf("unexpected fallback runtime root: %q", root)
	}

	parent, err := os.MkdirTemp("", "omp-private-parent-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(parent) })
	unsafeLeaf := filepath.Join(parent, "unsafe")
	if err := os.Mkdir(unsafeLeaf, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDirectory(unsafeLeaf); err == nil {
		t.Fatal("permissive private leaf must be rejected")
	}

	target := filepath.Join(parent, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(parent, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDirectory(filepath.Join(link, "child")); err == nil {
		t.Fatal("symlink directory ancestor must be rejected")
	}

	writableAncestor := filepath.Join(parent, "writable")
	if err := os.Mkdir(writableAncestor, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(writableAncestor, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDirectory(filepath.Join(writableAncestor, "child")); err == nil {
		t.Fatal("group/world writable ancestor must be rejected")
	}
}

func TestPrivateJSONUsesPrivateFilesAndRejectsSymlinks(t *testing.T) {
	root, err := os.MkdirTemp("", "omp-private-json-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	privateDirectory := filepath.Join(root, "private")
	if err := EnsurePrivateDirectory(privateDirectory); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(privateDirectory, "record.json")
	if err := WritePrivateJSON(file, map[string]any{"state": "running"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("private file mode = %04o, want 0600", info.Mode().Perm())
	}
	var value map[string]string
	if err := ReadPrivateJSON(file, &value); err != nil {
		t.Fatal(err)
	}
	if value["state"] != "running" {
		t.Fatalf("unexpected private JSON: %#v", value)
	}

	target := filepath.Join(root, "outside.json")
	if err := os.WriteFile(target, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(privateDirectory, "linked.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := WritePrivateJSON(link, map[string]bool{"replaced": true}); err == nil {
		t.Fatal("writing through symlink target must fail")
	}
	if err := ReadPrivateJSON(link, &value); err == nil {
		t.Fatal("reading through symlink target must fail")
	}
	contents, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "original" {
		t.Fatalf("symlink target changed: %q", contents)
	}
}

func TestReadRecordsValidatesFilenameIdentityScopeAndShape(t *testing.T) {
	transport, scope := testTransport(t)
	validRecord := testRecord(scope, testInstanceID)
	validPath := filepath.Join(transport.directory, testInstanceID+".json")
	if err := WritePrivateJSON(validPath, validRecord); err != nil {
		t.Fatal(err)
	}
	records, err := transport.ReadRecords()
	if err != nil || len(records) != 1 || records[0].InstanceID != testInstanceID {
		t.Fatalf("valid record not discovered: records=%#v err=%v", records, err)
	}

	if err := os.Remove(validPath); err != nil {
		t.Fatal(err)
	}
	wrongIdentity := testRecord(scope, strings.Repeat("b", 32))
	if err := WritePrivateJSON(validPath, wrongIdentity); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.ReadRecords(); err == nil || !strings.Contains(err.Error(), "filename does not match") {
		t.Fatalf("record identity/filename mismatch was accepted: %v", err)
	}

	if err := os.Remove(validPath); err != nil {
		t.Fatal(err)
	}
	wrongScope := testRecord(scope, testInstanceID)
	wrongScope.Scope = "another-scope"
	if err := WritePrivateJSON(validPath, wrongScope); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.ReadRecords(); err == nil {
		t.Fatal("cross-scope record must be rejected")
	}

	if err := os.Remove(validPath); err != nil {
		t.Fatal(err)
	}
	if err := WritePrivateJSON(validPath, map[string]any{"version": 1, "instanceId": testInstanceID}); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.ReadRecords(); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("incomplete record shape was accepted: %v", err)
	}
	if err := os.Remove(validPath); err != nil {
		t.Fatal(err)
	}

	badFilename := filepath.Join(transport.directory, "not-an-instance.json")
	if err := WritePrivateJSON(badFilename, validRecord); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.ReadRecords(); err == nil || !strings.Contains(err.Error(), "filename") {
		t.Fatalf("invalid record filename was accepted: %v", err)
	}
}

func TestRecordsAreSeparatedByScopeIdentity(t *testing.T) {
	root, err := os.MkdirTemp("", "t-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Setenv("XDG_RUNTIME_DIR", root)
	firstScope := protocol.Scope{ID: "scope-one"}
	secondScope := protocol.Scope{ID: "scope-two"}
	first, err := NewTransport(firstScope)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewTransport(secondScope)
	if err != nil {
		t.Fatal(err)
	}
	record := testRecord(firstScope, testInstanceID)
	if err := WritePrivateJSON(filepath.Join(first.directory, testInstanceID+".json"), record); err != nil {
		t.Fatal(err)
	}
	firstRecords, err := first.ReadRecords()
	if err != nil {
		t.Fatal(err)
	}
	secondRecords, err := second.ReadRecords()
	if err != nil {
		t.Fatal(err)
	}
	if len(firstRecords) != 1 || firstRecords[0].Scope != firstScope.ID || len(secondRecords) != 0 {
		t.Fatalf("scope isolation failed: first=%#v second=%#v", firstRecords, secondRecords)
	}
}

func TestRequestInteroperatesWithCorrelatedOMPResponse(t *testing.T) {
	transport, scope := testTransport(t)
	record := testRecord(scope, testInstanceID)
	startSocketReply(t, transport, func(request protocol.Request) protocol.Response {
		if request.Version != protocol.Version || request.InstanceID != testInstanceID || request.Action != "status" || request.RequestID == "" {
			t.Errorf("unexpected native request: %#v", request)
		}
		return protocol.Response{
			Version:    protocol.Version,
			InstanceID: request.InstanceID,
			RequestID:  request.RequestID,
			OK:         true,
			Data:       &protocol.Data{State: "running", CWD: "/workspace", CanRestart: true},
		}
	})
	request, err := protocol.CreateRequest(record.InstanceID, "status")
	if err != nil {
		t.Fatal(err)
	}
	response, err := transport.Request(record, request)
	if err != nil {
		t.Fatal(err)
	}
	if !response.OK || response.Data == nil || response.Data.State != "running" || !response.Data.CanRestart {
		t.Fatalf("unexpected OMP status response: %#v", response)
	}
}

func TestInvalidAcknowledgementRemainsUnknownAndHostRejectionFails(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		reply  func(protocol.Request) protocol.Response
		status string
	}{
		{
			name: "wrong-instance",
			reply: func(request protocol.Request) protocol.Response {
				return protocol.Response{Version: protocol.Version, InstanceID: strings.Repeat("b", 32), RequestID: request.RequestID, OK: true, Data: &protocol.Data{}}
			},
			status: "unknown",
		},
		{
			name: "missing-data",
			reply: func(request protocol.Request) protocol.Response {
				return protocol.Response{Version: protocol.Version, InstanceID: request.InstanceID, RequestID: request.RequestID, OK: true}
			},
			status: "unknown",
		},
		{
			name: "host-rejection",
			reply: func(request protocol.Request) protocol.Response {
				return protocol.Response{Version: protocol.Version, InstanceID: request.InstanceID, RequestID: request.RequestID, Error: &protocol.Error{Code: "NOT_READY", Message: "The instance is not ready"}}
			},
			status: "failed",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			transport, scope := testTransport(t)
			record := testRecord(scope, testInstanceID)
			if err := WritePrivateJSON(filepath.Join(transport.directory, testInstanceID+".json"), record); err != nil {
				t.Fatal(err)
			}
			startSocketReply(t, transport, testCase.reply)
			rows, err := cli.ListInstances(transport)
			if err != nil {
				t.Fatal(err)
			}
			if len(rows) != 1 || rows[0].Status != testCase.status {
				t.Fatalf("acknowledgement status = %#v, want %q", rows, testCase.status)
			}
		})
	}
}

func TestRequestMissingSocketIsUnreachableAndOversizedAckUnknown(t *testing.T) {
	transport, scope := testTransport(t)
	record := testRecord(scope, testInstanceID)
	if err := WritePrivateJSON(filepath.Join(transport.directory, testInstanceID+".json"), record); err != nil {
		t.Fatal(err)
	}
	request, err := protocol.CreateRequest(record.InstanceID, "status")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.Request(record, request); !errors.Is(err, syscall.ENOENT) && !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("missing socket should be unreachable, got %v", err)
	}

	startSocketBytes(t, transport, []byte(strings.Repeat("x", maxFrameBytes+1)))
	rows, err := cli.ListInstances(transport)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Status != "unknown" {
		t.Fatalf("oversized acknowledgement should remain unknown, got %#v", rows)
	}
}

func TestNativeJSONPreservesStatusNullsAndRestartCapabilityAbsence(t *testing.T) {
	for _, testCase := range []struct {
		name string
		data string
		want map[string]any
	}{
		{
			name: "status",
			data: `{"state":"running","sessionFile":null,"operationId":null,"lastRestart":null,"launcherManaged":true,"canRestart":false}`,
			want: map[string]any{
				"state": "running", "sessionFile": nil, "operationId": nil,
				"lastRestart": nil, "launcherManaged": true, "canRestart": false,
			},
		},
		{
			name: "restart",
			data: `{"state":"accepted","operationId":"operation-123","message":"Restart requested."}`,
			want: map[string]any{
				"state": "accepted", "operationId": "operation-123", "message": "Restart requested.",
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			transport, scope := testTransport(t)
			record := testRecord(scope, testInstanceID)
			if err := WritePrivateJSON(filepath.Join(transport.directory, testInstanceID+".json"), record); err != nil {
				t.Fatal(err)
			}
			startSocketBytesWithRequest(t, transport, func(request protocol.Request) []byte {
				return []byte(fmt.Sprintf(`{"version":1,"instanceId":%q,"requestId":%q,"ok":true,"data":%s}`+"\n", request.InstanceID, request.RequestID, testCase.data))
			})
			var rows []cli.Row
			var err error
			if testCase.name == "status" {
				rows, err = cli.ListInstances(transport)
			} else {
				rows, err = cli.RestartInstances(transport, false, testInstanceID)
			}
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(rows)
			if err != nil {
				t.Fatal(err)
			}
			var output []struct {
				Data map[string]any `json:"data"`
			}
			if err := json.Unmarshal(encoded, &output); err != nil {
				t.Fatal(err)
			}
			if len(output) != 1 || !reflect.DeepEqual(output[0].Data, testCase.want) {
				t.Fatalf("native JSON changed host field presence: %s", encoded)
			}
		})
	}
}

func startSocketReply(t *testing.T, transport *Transport, responseFor func(protocol.Request) protocol.Response) {
	t.Helper()
	startSocketBytesWithRequest(t, transport, func(request protocol.Request) []byte {
		encoded, err := json.Marshal(responseFor(request))
		if err != nil {
			t.Errorf("encode test response: %v", err)
			return nil
		}
		return append(encoded, '\n')
	})
}

func startSocketBytes(t *testing.T, transport *Transport, response []byte) {
	t.Helper()
	startSocketBytesWithRequest(t, transport, func(protocol.Request) []byte { return response })
}

func startSocketBytesWithRequest(t *testing.T, transport *Transport, responseFor func(protocol.Request) []byte) {
	t.Helper()
	socket := filepath.Join(transport.directory, testInstanceID+".sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
		_ = os.Remove(socket)
	})
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		line, err := bufio.NewReader(connection).ReadBytes('\n')
		if err != nil {
			return
		}
		var request protocol.Request
		if err := json.Unmarshal(line, &request); err != nil {
			return
		}
		_ = writeAll(connection, responseFor(request))
	}()
}
