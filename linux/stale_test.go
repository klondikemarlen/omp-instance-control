package linux

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const secondCleanupTestInstanceID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func TestCleanupRecordsRemovesDeadProcessRecordAndStaleSocket(t *testing.T) {
	transport, scope := testTransport(t)
	pid := reapedCleanupTestChildPID(t)
	record := testRecord(scope, testInstanceID)
	record.PID = pid
	writeCleanupTestRecord(t, transport, record)
	socketFile := filepath.Join(transport.directory, testInstanceID+".sock")
	createStaleCleanupTestSocket(t, socketFile)

	results, err := transport.CleanupRecords()
	if err != nil {
		t.Fatal(err)
	}
	result := cleanupTestResult(t, results, testInstanceID)
	if result.Status != "removed" {
		t.Fatalf("cleanup status = %q, want removed: %s", result.Status, result.Reason)
	}
	if _, err := os.Lstat(filepath.Join(transport.directory, testInstanceID+".json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("record still exists or could not be checked: %v", err)
	}
	if _, err := os.Lstat(socketFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket still exists or could not be checked: %v", err)
	}
}

func TestCleanupRecordsPreservesPresentPID(t *testing.T) {
	transport, scope := testTransport(t)
	record := testRecord(scope, testInstanceID)
	record.PID = os.Getpid()
	recordFile := writeCleanupTestRecord(t, transport, record)

	results, err := transport.CleanupRecords()
	if err != nil {
		t.Fatal(err)
	}
	result := cleanupTestResult(t, results, testInstanceID)
	if result.Status != "preserved" {
		t.Fatalf("cleanup status = %q, want preserved: %s", result.Status, result.Reason)
	}
	if _, err := os.Lstat(recordFile); err != nil {
		t.Fatalf("live process record was not preserved: %v", err)
	}
}

func TestCleanupRecordsPreservesUnsafeRecordAndSocket(t *testing.T) {
	transport, scope := testTransport(t)
	deadPID := reapedCleanupTestChildPID(t)

	unsafeRecord := testRecord(scope, testInstanceID)
	unsafeRecord.PID = deadPID
	unsafeRecordFile := writeCleanupTestRecord(t, transport, unsafeRecord)
	if err := os.Chmod(unsafeRecordFile, 0o644); err != nil {
		t.Fatal(err)
	}

	unsafeSocketRecord := testRecord(scope, secondCleanupTestInstanceID)
	unsafeSocketRecord.PID = deadPID
	unsafeSocketRecordFile := writeCleanupTestRecord(t, transport, unsafeSocketRecord)
	unsafeSocketFile := filepath.Join(transport.directory, secondCleanupTestInstanceID+".sock")
	if err := os.WriteFile(unsafeSocketFile, []byte("not a socket"), 0o600); err != nil {
		t.Fatal(err)
	}

	results, err := transport.CleanupRecords()
	if err != nil {
		t.Fatal(err)
	}
	for _, instanceID := range []string{testInstanceID, secondCleanupTestInstanceID} {
		if result := cleanupTestResult(t, results, instanceID); result.Status != "failed" {
			t.Errorf("%s cleanup status = %q, want failed: %s", instanceID, result.Status, result.Reason)
		}
	}
	for _, file := range []string{unsafeRecordFile, unsafeSocketRecordFile, unsafeSocketFile} {
		if _, err := os.Lstat(file); err != nil {
			t.Errorf("unsafe file %s was not preserved: %v", file, err)
		}
	}
}

func TestCleanupRecordsPreservesResponsiveEndpointForAbsentPID(t *testing.T) {
	transport, scope := testTransport(t)
	record := testRecord(scope, testInstanceID)
	record.PID = reapedCleanupTestChildPID(t)
	recordFile := writeCleanupTestRecord(t, transport, record)
	socketFile := filepath.Join(transport.directory, testInstanceID+".sock")
	listener, err := net.Listen("unix", socketFile)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(socketFile, 0o600); err != nil {
		t.Fatal(err)
	}

	results, err := transport.CleanupRecords()
	if err != nil {
		t.Fatal(err)
	}
	result := cleanupTestResult(t, results, testInstanceID)
	if result.Status != "preserved" {
		t.Fatalf("cleanup status = %q, want preserved: %s", result.Status, result.Reason)
	}
	for _, file := range []string{recordFile, socketFile} {
		if _, err := os.Lstat(file); err != nil {
			t.Errorf("responsive endpoint file %s was not preserved: %v", file, err)
		}
	}
}

func TestCleanupRecordsIsScopedToTransportDirectory(t *testing.T) {
	firstTransport, firstScope := testTransport(t)
	secondTransport, err := NewTransport(protocol.Scope{ID: "another-scope-identity"})
	if err != nil {
		t.Fatal(err)
	}
	deadPID := reapedCleanupTestChildPID(t)
	firstRecord := testRecord(firstScope, testInstanceID)
	firstRecord.PID = deadPID
	firstFile := writeCleanupTestRecord(t, firstTransport, firstRecord)
	secondRecord := testRecord(secondTransport.scope, testInstanceID)
	secondRecord.PID = deadPID
	secondFile := writeCleanupTestRecord(t, secondTransport, secondRecord)

	results, err := firstTransport.CleanupRecords()
	if err != nil {
		t.Fatal(err)
	}
	if result := cleanupTestResult(t, results, testInstanceID); result.Status != "removed" {
		t.Fatalf("cleanup status = %q, want removed: %s", result.Status, result.Reason)
	}
	if _, err := os.Lstat(firstFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("first-scope record still exists or could not be checked: %v", err)
	}
	if _, err := os.Lstat(secondFile); err != nil {
		t.Fatalf("other-scope record was not preserved: %v", err)
	}
}

func TestCleanupRecordUnchangedRequiresExactRecordIdentity(t *testing.T) {
	transport, scope := testTransport(t)
	record := testRecord(scope, testInstanceID)
	recordFile := writeCleanupTestRecord(t, transport, record)
	encoded, _, err := readCleanupRecord(recordFile, scope, testInstanceID)
	if err != nil {
		t.Fatal(err)
	}

	changed := record
	changed.PID++
	if err := WritePrivateJSON(recordFile, changed); err != nil {
		t.Fatal(err)
	}
	if cleanupRecordUnchanged(recordFile, scope, testInstanceID, encoded) {
		t.Fatal("changed record identity was accepted as unchanged")
	}
}

func writeCleanupTestRecord(t *testing.T, transport *Transport, record protocol.Record) string {
	t.Helper()
	file := filepath.Join(transport.directory, record.InstanceID+".json")
	if err := WritePrivateJSON(file, record); err != nil {
		t.Fatal(err)
	}
	return file
}

func createStaleCleanupTestSocket(t *testing.T, file string) {
	t.Helper()
	listener, err := net.Listen("unix", file)
	if err != nil {
		t.Fatal(err)
	}
	unixListener := listener.(*net.UnixListener)
	unixListener.SetUnlinkOnClose(false)
	if err := unixListener.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, 0o600); err != nil {
		t.Fatal(err)
	}
}

func reapedCleanupTestChildPID(t *testing.T) int {
	t.Helper()
	command := exec.Command("sh", "-c", "exit 0")
	if err := command.Run(); err != nil {
		t.Fatal(err)
	}
	pid := command.Process.Pid
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("reaped child PID %d was not confirmed absent: %v", pid, err)
	}
	return pid
}

func cleanupTestResult(t *testing.T, results []CleanupResult, instanceID string) CleanupResult {
	t.Helper()
	for _, result := range results {
		if result.InstanceID == instanceID {
			return result
		}
	}
	t.Fatalf("no cleanup result for %s in %#v", instanceID, results)
	return CleanupResult{}
}
