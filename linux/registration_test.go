package linux

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const testLaunchToken = "11111111111111111111111111111111"
const testRegistrationScope = "0123456789abcdef"

func TestCleanupLaunchRegistrationsRemovesOwnedRecordAndSocket(t *testing.T) {
	launchDir, scope, registration, recordPath, socketFile := prepareRegistrationCleanup(t, nil)
	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(recordPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("owned record was not removed: %v", err)
	}
	if _, err := os.Lstat(socketFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("owned socket was not removed: %v", err)
	}
	registrationFile := filepath.Join(launchDir, launchRegistrationPrefix+registration.InstanceID+launchRegistrationSuffix)
	if _, err := os.Lstat(registrationFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("consumed handoff was not removed: %v", err)
	}
}

func TestCleanupLaunchRegistrationsRemovesNativeRestartIdentities(t *testing.T) {
	launchDir, scope, _, firstRecord, firstSocket := prepareRegistrationCleanup(t, nil)
	transport, err := NewTransport(scope)
	if err != nil {
		t.Fatal(err)
	}
	second := launchRegistration{
		Version: protocol.Version, Token: testLaunchToken, Scope: scope.ID,
		InstanceID: strings.Repeat("b", 32), PID: os.Getpid(),
	}
	secondRegistrationFile := filepath.Join(
		launchDir,
		launchRegistrationPrefix+second.InstanceID+launchRegistrationSuffix,
	)
	if err := WritePrivateJSON(secondRegistrationFile, second); err != nil {
		t.Fatal(err)
	}
	secondSocket := createRegistrationTestSocket(t, transport.directory, second.InstanceID)
	secondRecord := filepath.Join(transport.directory, second.InstanceID+".json")
	if err := WritePrivateJSON(secondRecord, testRecord(scope, second.InstanceID)); err != nil {
		t.Fatal(err)
	}

	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{firstRecord, firstSocket, secondRecord, secondSocket} {
		if _, err := os.Lstat(file); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("native restart registration artifact remained at %s: %v", file, err)
		}
	}
}

func TestCleanupLaunchRegistrationsDoesNotDeleteNativeRestartReplacement(t *testing.T) {
	launchDir, scope, _, oldRecord, oldSocket := prepareRegistrationCleanup(t, nil)
	transport, err := NewTransport(scope)
	if err != nil {
		t.Fatal(err)
	}
	replacementID := strings.Repeat("c", 32)
	replacementSocket := createRegistrationTestSocket(t, transport.directory, replacementID)
	replacementRecord := filepath.Join(transport.directory, replacementID+".json")
	if err := WritePrivateJSON(replacementRecord, testRecord(scope, replacementID)); err != nil {
		t.Fatal(err)
	}

	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{oldRecord, oldSocket} {
		if _, err := os.Lstat(file); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("old registration artifact remained at %s: %v", file, err)
		}
	}
	assertRegistrationArtifactsExist(t, replacementRecord, replacementSocket)
}

func TestCleanupLaunchRegistrationsRemovesSocketWithoutPublishedRecord(t *testing.T) {
	launchDir, scope, _, recordPath, socketFile := prepareRegistrationCleanup(t, nil)
	if err := os.Remove(recordPath); err != nil {
		t.Fatal(err)
	}
	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(socketFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("owned pre-publication socket was not removed: %v", err)
	}
}

func TestCleanupLaunchRegistrationsRefusesAnotherLaunchToken(t *testing.T) {
	wrongToken := "22222222222222222222222222222222"
	launchDir, scope, _, recordPath, socketFile := prepareRegistrationCleanup(t, func(registration *launchRegistration, _ *protocol.Record) {
		registration.Token = wrongToken
	})
	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err == nil {
		t.Fatal("handoff for another launch was accepted")
	}
	assertRegistrationArtifactsExist(t, recordPath, socketFile)
}

func TestCleanupLaunchRegistrationsRefusesAnotherHostPID(t *testing.T) {
	launchDir, scope, _, recordPath, socketFile := prepareRegistrationCleanup(t, func(registration *launchRegistration, _ *protocol.Record) {
		registration.PID++
	})
	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err == nil {
		t.Fatal("handoff for another host PID was accepted")
	}
	assertRegistrationArtifactsExist(t, recordPath, socketFile)
}

func TestCleanupLaunchRegistrationsRefusesAnotherScope(t *testing.T) {
	launchDir, scope, _, recordPath, socketFile := prepareRegistrationCleanup(t, func(registration *launchRegistration, _ *protocol.Record) {
		registration.Scope = "fedcba9876543210"
	})
	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err == nil {
		t.Fatal("handoff for another scope was accepted")
	}
	assertRegistrationArtifactsExist(t, recordPath, socketFile)
}

func TestCleanupLaunchRegistrationsPreservesChangedRecordAndLiveReplacement(t *testing.T) {
	launchDir, scope, _, recordPath, socketFile := prepareRegistrationCleanup(t, func(_ *launchRegistration, record *protocol.Record) {
		record.PID++
	})
	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	assertRegistrationArtifactsExist(t, recordPath, socketFile)
}

func TestCleanupLaunchRegistrationsRefusesSymlinkRecord(t *testing.T) {
	launchDir, scope, _, recordPath, socketFile := prepareRegistrationCleanup(t, nil)
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte("owned elsewhere"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(recordPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, recordPath); err != nil {
		t.Fatal(err)
	}
	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err == nil {
		t.Fatal("symlink record was accepted")
	}
	if _, err := os.Lstat(recordPath); err != nil {
		t.Fatalf("record symlink was removed: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("symlink target was changed: %v", err)
	}
	if _, err := os.Lstat(socketFile); err != nil {
		t.Fatalf("socket was removed despite unsafe record: %v", err)
	}
}

func TestCleanupLaunchRegistrationsRefusesSymlinkSocket(t *testing.T) {
	launchDir, scope, _, recordPath, socketFile := prepareRegistrationCleanup(t, nil)
	outside := filepath.Join(t.TempDir(), "outside.sock")
	if err := os.WriteFile(outside, []byte("owned elsewhere"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(socketFile); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, socketFile); err != nil {
		t.Fatal(err)
	}
	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err == nil {
		t.Fatal("symlink socket was accepted")
	}
	if _, err := os.Lstat(socketFile); err != nil {
		t.Fatalf("socket symlink was removed: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("symlink target was changed: %v", err)
	}
	if _, err := os.Lstat(recordPath); err != nil {
		t.Fatalf("record was removed despite unsafe socket: %v", err)
	}
}

func TestCleanupLaunchRegistrationsRefusesSymlinkHandoff(t *testing.T) {
	launchDir, scope, registration, recordPath, socketFile := prepareRegistrationCleanup(t, nil)
	registrationFile := filepath.Join(
		launchDir,
		launchRegistrationPrefix+registration.InstanceID+launchRegistrationSuffix,
	)
	outside := filepath.Join(launchDir, "unrelated-registration.json")
	if err := WritePrivateJSON(outside, registration); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(registrationFile); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, registrationFile); err != nil {
		t.Fatal(err)
	}
	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err == nil {
		t.Fatal("symlink handoff was accepted")
	}
	if _, err := os.Lstat(registrationFile); err != nil {
		t.Fatalf("handoff symlink was removed: %v", err)
	}
	assertRegistrationArtifactsExist(t, recordPath, socketFile)
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("handoff target was changed: %v", err)
	}
}

func TestCleanupLaunchRegistrationsLeavesRecordsWithoutOwnershipHandoff(t *testing.T) {
	launchDir, scope, registration, recordPath, socketFile := prepareRegistrationCleanup(t, nil)
	registrationFile := filepath.Join(launchDir, launchRegistrationPrefix+registration.InstanceID+launchRegistrationSuffix)
	if err := os.Remove(registrationFile); err != nil {
		t.Fatal(err)
	}
	if err := cleanupLaunchRegistrations(launchDir, testLaunchToken, scope, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	assertRegistrationArtifactsExist(t, recordPath, socketFile)
}

func prepareRegistrationCleanup(
	t *testing.T,
	change func(*launchRegistration, *protocol.Record),
) (string, protocol.Scope, launchRegistration, string, string) {
	t.Helper()
	root, err := os.MkdirTemp("", "r-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Setenv("XDG_RUNTIME_DIR", root)
	launchDir := filepath.Join(root, "launch")
	if err := os.Mkdir(launchDir, 0o700); err != nil {
		t.Fatal(err)
	}
	scope := protocol.Scope{ID: testRegistrationScope}
	transport, err := NewTransport(scope)
	if err != nil {
		t.Fatal(err)
	}
	registration := launchRegistration{
		Version: protocol.Version, Token: testLaunchToken, Scope: scope.ID,
		InstanceID: testInstanceID, PID: os.Getpid(),
	}
	record := testRecord(scope, registration.InstanceID)
	if change != nil {
		change(&registration, &record)
	}
	registrationFile := filepath.Join(launchDir, launchRegistrationPrefix+registration.InstanceID+launchRegistrationSuffix)
	if err := WritePrivateJSON(registrationFile, registration); err != nil {
		t.Fatal(err)
	}
	socketFile := createRegistrationTestSocket(t, transport.directory, registration.InstanceID)
	recordPath := filepath.Join(transport.directory, registration.InstanceID+".json")
	if err := WritePrivateJSON(recordPath, record); err != nil {
		t.Fatal(err)
	}
	return launchDir, scope, registration, recordPath, socketFile
}

func createRegistrationTestSocket(t *testing.T, directory, instanceID string) string {
	t.Helper()
	listener, err := net.Listen("unix", filepath.Join(directory, instanceID+".sock"))
	if err != nil {
		t.Fatal(err)
	}
	listener.(*net.UnixListener).SetUnlinkOnClose(false)
	socketFile := listener.Addr().String()
	if err := os.Chmod(socketFile, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return socketFile
}

func assertRegistrationArtifactsExist(t *testing.T, recordPath, socketFile string) {
	t.Helper()
	if _, err := os.Lstat(recordPath); err != nil {
		t.Fatalf("record was removed: %v", err)
	}
	if _, err := os.Lstat(socketFile); err != nil {
		t.Fatalf("socket was removed: %v", err)
	}
}
