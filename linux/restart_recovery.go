package linux

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"syscall"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

type restartFileIdentity struct {
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}

type failedRestartRecord struct {
	Version         int                   `json:"version"`
	Session         protocol.SavedSession `json:"session"`
	Restart         restartRecord         `json:"restart"`
	SessionIdentity restartFileIdentity   `json:"sessionIdentity"`
	CWDIdentity     restartFileIdentity   `json:"cwdIdentity"`
	Failure         string                `json:"failure,omitempty"`
}

func failedRestartPath(scope protocol.Scope, operationID string) string {
	identity := sha256.Sum256([]byte(operationID))
	return filepath.Join(scope.AgentDir, "instance-control", "restore", "failed-restarts", fmt.Sprintf("%x.json", identity))
}

func existingRestartRecovery(scope protocol.Scope, operationID string) string {
	if operationID == "" {
		return ""
	}
	file := failedRestartPath(scope, operationID)
	record, err := readFailedRestart(file)
	if err != nil || record.Session.Scope != scope || record.Restart.OperationID != operationID {
		return ""
	}
	return file
}

func restartPathIdentity(path string, directory bool) (restartFileIdentity, error) {
	if err := validateRestorePath(path, directory); err != nil {
		return restartFileIdentity{}, err
	}
	var stat syscall.Stat_t
	if err := syscall.Stat(path, &stat); err != nil {
		return restartFileIdentity{}, err
	}
	return restartFileIdentity{Device: uint64(stat.Dev), Inode: stat.Ino}, nil
}

// preserveRestartRecovery records the exact accepted handoff, not an alias to an
// evolving slot. It runs before exec and before the ephemeral handoff is removed.
func preserveRestartRecovery(scope protocol.Scope, restoreID string, args []string, handoff handoffRecord) (string, error) {
	session, err := SavedSessionForRestoreID(scope, restoreID)
	if err != nil {
		return "", err
	}
	if session.SessionFile != handoff.SessionFile || session.CWD != handoff.CWD || !slices.Equal(session.ResumeArgs, args) {
		return "", errors.New("the persisted slot does not match the accepted restart handoff")
	}
	sessionID, valid, err := readLegacySessionID(session.SessionFile)
	if err != nil {
		return "", err
	}
	if !valid || sessionID != session.SessionID {
		return "", errors.New("the transcript header does not match the accepted session")
	}
	sessionIdentity, err := restartPathIdentity(session.SessionFile, false)
	if err != nil {
		return "", err
	}
	cwdIdentity, err := restartPathIdentity(session.CWD, true)
	if err != nil {
		return "", err
	}
	record := failedRestartRecord{
		Version: 1, Session: session,
		Restart:         restartRecord{OperationID: handoff.OperationID, PreviousInstanceID: handoff.InstanceID},
		SessionIdentity: sessionIdentity, CWDIdentity: cwdIdentity,
	}
	file := failedRestartPath(scope, handoff.OperationID)
	if err := WritePrivateJSON(file, record); err != nil {
		return "", err
	}
	return file, nil
}

func readFailedRestart(file string) (failedRestartRecord, error) {
	var record failedRestartRecord
	if !filepath.IsAbs(file) || filepath.Clean(file) != file {
		return record, errors.New("restart recovery requires a normalized absolute record path")
	}
	if err := EnsurePrivateDirectory(filepath.Dir(file)); err != nil {
		return record, err
	}
	if err := readRestoreJSON(file, &record); err != nil {
		return record, fmt.Errorf("read private restart recovery record: %w", err)
	}
	if record.Version != 1 || record.SessionIdentity.Inode == 0 || record.CWDIdentity.Inode == 0 {
		return record, errors.New("invalid restart recovery record identity")
	}
	session := record.Session
	if _, err := ensureRestoreDirectories(session.Scope); err != nil {
		return record, err
	}
	if file != failedRestartPath(session.Scope, record.Restart.OperationID) {
		return record, errors.New("restart recovery record path does not match its original scope and operation")
	}
	if err := validateSavedSession(session, session.Scope, session.RestoreID, false); err != nil {
		return record, err
	}
	request := protocol.Request{
		Version: protocol.Version, InstanceID: record.Restart.PreviousInstanceID,
		RequestID: record.Restart.OperationID, Action: "restart-wrapper",
	}
	if err := protocol.ValidateRequest(request); err != nil {
		return record, err
	}
	return record, nil
}

func validateFailedRestartTarget(record failedRestartRecord) error {
	session := record.Session
	if err := validateSavedSession(session, session.Scope, session.RestoreID, true); err != nil {
		return err
	}
	identity, err := restartPathIdentity(session.SessionFile, false)
	if err != nil {
		return err
	}
	if identity != record.SessionIdentity {
		return errors.New("the failed restart transcript was replaced; refusing a different file")
	}
	sessionID, valid, err := readLegacySessionID(session.SessionFile)
	if err != nil {
		return err
	}
	if !valid || sessionID != session.SessionID {
		return errors.New("the failed restart session identity changed")
	}
	identity, err = restartPathIdentity(session.CWD, true)
	if err != nil {
		return err
	}
	if identity != record.CWDIdentity {
		return errors.New("the failed restart working directory was replaced")
	}
	return ensureWorkingDirectory(session.CWD)
}

func restartRecoveryFailure(file string, failure error) error {
	if file == "" {
		return failure
	}
	record, err := readFailedRestart(file)
	if err != nil {
		return fmt.Errorf("%w; restart recovery record unavailable: %v", failure, err)
	}
	record.Failure = failure.Error()
	if err := WritePrivateJSON(file, record); err != nil {
		return fmt.Errorf("%w; cannot preserve restart failure: %v; recovery record: %q", failure, err, file)
	}
	return fmt.Errorf("%w\nRestart operation %q for instance %s failed.\nRepair the reported prerequisite, then recover explicitly with:\n  ompi control recover %s", failure, record.Restart.OperationID, record.Restart.PreviousInstanceID, shellQuote(file))
}

// RecoverFailedRestart resumes only the exact captured failed handoff. Reading
// the latest slot never selects a replacement conversation, and the normal slot
// lock remains held by both launcher and child throughout manual recovery.
func RecoverFailedRestart(file, extensionPath, nativeVersion string) (int, error) {
	return recoverFailedRestart(file, stdinIsTerminal() && stdoutIsTerminal(), func(record failedRestartRecord, lock *os.File) (int, error) {
		session := record.Session
		return launchWithResume(session.ResumeArgs, extensionPath, nativeVersion, session.RestoreID, lock,
			&resumeState{cwd: session.CWD, sessionFile: session.SessionFile, restart: record.Restart, recoveryFile: file})
	})
}

func recoverFailedRestart(file string, hasTerminal bool, launchSession func(failedRestartRecord, *os.File) (int, error)) (int, error) {
	record, err := readFailedRestart(file)
	if err != nil {
		return 1, err
	}
	if !hasTerminal {
		return 1, errors.New("failed restart recovery requires an interactive terminal")
	}
	session := record.Session
	restoreEnvironment, err := anchorRestoreEnvironment(session.Scope)
	if err != nil {
		return 1, err
	}
	defer restoreEnvironment()
	scope, err := protocol.GetScope(session.Scope.Profile, session.CWD)
	if err != nil || scope != session.Scope {
		return 1, errors.New("the failed restart configuration scope is inconsistent")
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return 1, err
	}
	lock, err := lockRestoreSnapshot(directories, session.RestoreID)
	if err != nil {
		return 1, err
	}
	defer lock.Close()
	if err := requireRestoreOwnerStopped(session.Owner); err != nil {
		return 1, fmt.Errorf("original launcher may still be active: %w", err)
	}
	if err := requireRestoreOwnerStopped(session.AgentOwner); err != nil {
		return 1, fmt.Errorf("original OMP process may still be active: %w", err)
	}
	current, err := readSavedSession(directories, scope, session.RestoreID, false)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return 1, err
	}
	if err == nil {
		if !sameSelectedRestoreSession(session, current, scope, session.RestoreID) {
			return 1, errors.New("the recovery slot has changed conversation or launch options")
		}
		if err := requireRestoreOwnerStopped(current.Owner); err != nil {
			return 1, err
		}
		if err := requireRestoreOwnerStopped(current.AgentOwner); err != nil {
			return 1, err
		}
	}
	if err := validateFailedRestartTarget(record); err != nil {
		return 1, fmt.Errorf("repair the exact failed restart target before recovering: %w", err)
	}
	previousCWD, err := os.Getwd()
	if err != nil {
		return 1, err
	}
	if err := os.Chdir(session.CWD); err != nil {
		return 1, err
	}
	defer func() { _ = os.Chdir(previousCWD) }()

	code, err := launchSession(record, lock)
	if err != nil {
		return code, err
	}
	if code == 0 {
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return 1, fmt.Errorf("remove completed restart recovery record: %w", err)
		}
	}
	return code, nil
}
