package linux

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const maxRestorePayloadBytes = 1 << 20
const unavailableRestoreSnapshotReason = "Current wrapper slot has no persisted restore snapshot; it cannot be restored until a current session is persisted."

var restoreProfilePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

type restoreNameRecord struct {
	Version   int    `json:"version"`
	RestoreID string `json:"restoreId"`
}

type restoreDirectories struct {
	root        string
	snapshots   string
	names       string
	checkpoints string
}

// NewRestoreOwner captures Linux boot and process identity for a PID.
func NewRestoreOwner(pid int) (protocol.RestoreOwner, error) {
	if pid <= 0 {
		return protocol.RestoreOwner{}, errors.New("restore owner PID must be positive")
	}
	bootID, err := readBootID()
	if err != nil {
		return protocol.RestoreOwner{}, fmt.Errorf("read Linux boot identity: %w", err)
	}
	startTime, err := readProcessStartTime(pid)
	if err != nil {
		return protocol.RestoreOwner{}, fmt.Errorf("read launcher process identity for PID %d: %w", pid, err)
	}
	return protocol.RestoreOwner{BootID: bootID, PID: pid, StartTime: startTime}, nil
}

// SaveRestoreName immutably binds a safe name to an existing managed-session snapshot.
func SaveRestoreName(scope protocol.Scope, name, restoreID string) error {
	if err := protocol.ValidateRestoreName(name); err != nil {
		return err
	}
	if !validInstanceID(restoreID) {
		return errors.New("restore ID must be 32 lowercase hexadecimal characters")
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return err
	}
	session, err := readSavedSession(directories, scope, restoreID, true)
	if err != nil {
		return fmt.Errorf("cannot save restore name %q: %w", name, err)
	}
	if err := createImmutableRestoreName(directories, name, session.RestoreID); err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("restore name %q already exists; names cannot be overwritten", name)
		}
		return fmt.Errorf("save restore name %q: %w", name, err)
	}
	return nil
}

// SavedSessionForRestoreID reads and validates an unbound snapshot by its wrapper identity.
func SavedSessionForRestoreID(scope protocol.Scope, restoreID string) (protocol.SavedSession, error) {
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return protocol.SavedSession{}, err
	}
	return readSavedSession(directories, scope, restoreID, true)
}

// ListSavedSessions returns every explicitly named snapshot in the requested scope.
func ListSavedSessions(scope protocol.Scope) ([]protocol.NamedSession, error) {
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directories.names)
	if err != nil {
		return nil, fmt.Errorf("read saved restore names: %w", err)
	}

	sessions := make([]protocol.NamedSession, 0, len(entries))
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".json")
		if err := protocol.ValidateRestoreName(name); err != nil {
			return nil, fmt.Errorf("unsafe saved restore name file %q: %w", entry.Name(), err)
		}
		record, err := readRestoreName(directories, name)
		if err != nil {
			return nil, fmt.Errorf("read saved restore name %q: %w", name, err)
		}
		session, err := readSavedSession(directories, scope, record.RestoreID, false)
		if errors.Is(err, os.ErrNotExist) {
			sessions = append(sessions, protocol.NamedSession{
				Name:        name,
				Unavailable: unavailableRestoreSnapshotReason,
			})
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("saved restore name %q refers to an invalid snapshot: %w", name, err)
		}
		sessions = append(sessions, protocol.NamedSession{Name: name, Session: session})
	}
	slices.SortFunc(sessions, func(left, right protocol.NamedSession) int {
		return strings.Compare(left.Name, right.Name)
	})
	return sessions, nil
}

// RestoreNamedSession resumes the selected named transcript in its recorded cwd.
// It holds a per-snapshot flock until the foreground launcher has returned.
func RestoreNamedSession(scope protocol.Scope, name, extensionPath string, expected protocol.SavedSession) (int, error) {
	return restoreNamedSessionWithExpected(scope, name, extensionPath, &expected, stdinIsTerminal() && stdoutIsTerminal(), launch)
}

func restoreNamedSession(scope protocol.Scope, name, extensionPath string, hasTerminal bool, launchSession func([]string, string, string, *os.File) (int, error)) (int, error) {
	return restoreNamedSessionWithExpected(scope, name, extensionPath, nil, hasTerminal, launchSession)
}

func restoreNamedSessionWithExpected(scope protocol.Scope, name, extensionPath string, expected *protocol.SavedSession, hasTerminal bool, launchSession func([]string, string, string, *os.File) (int, error)) (int, error) {
	if err := protocol.ValidateRestoreName(name); err != nil {
		return 0, err
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return 0, err
	}
	nameRecord, err := readRestoreName(directories, name)
	if err != nil {
		return 0, fmt.Errorf("read restore name %q: %w", name, err)
	}
	return restoreSessionSlotWithBinding(scope, nameRecord.RestoreID, name, extensionPath, hasTerminal, launchSession, expected)
}

// RestoreSessionSlot resumes the selected snapshot for one managed slot.
// The expected snapshot prevents confirmation-time changes from changing the
// session that the operator approved.
func RestoreSessionSlot(scope protocol.Scope, restoreID, extensionPath string, expected protocol.SavedSession) (int, error) {
	return restoreSessionSlotExpected(scope, restoreID, extensionPath, expected, stdinIsTerminal() && stdoutIsTerminal(), launch)
}

func restoreSessionSlot(scope protocol.Scope, restoreID, extensionPath string, hasTerminal bool, launchSession func([]string, string, string, *os.File) (int, error)) (int, error) {
	return restoreSessionSlotWithBinding(scope, restoreID, "", extensionPath, hasTerminal, launchSession, nil)
}

func restoreSessionSlotExpected(scope protocol.Scope, restoreID, extensionPath string, expected protocol.SavedSession, hasTerminal bool, launchSession func([]string, string, string, *os.File) (int, error)) (int, error) {
	return restoreSessionSlotWithBinding(scope, restoreID, "", extensionPath, hasTerminal, launchSession, &expected)
}

func restoreSessionSlotWithBinding(scope protocol.Scope, restoreID, name, extensionPath string, hasTerminal bool, launchSession func([]string, string, string, *os.File) (int, error), expected *protocol.SavedSession) (int, error) {
	if !validInstanceID(restoreID) {
		return 0, errors.New("invalid restore ID")
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return 0, err
	}
	lock, err := lockRestoreSnapshot(directories, restoreID)
	if err != nil {
		return 0, err
	}
	defer lock.Close()

	if name != "" {
		currentName, err := readRestoreName(directories, name)
		if err != nil {
			return 0, fmt.Errorf("recheck restore name %q: %w", name, err)
		}
		if currentName.RestoreID != restoreID {
			return 0, errors.New("restore name changed while acquiring its snapshot lock")
		}
	}
	session, err := readSavedSession(directories, scope, restoreID, true)
	if err != nil {
		if name != "" {
			return 0, fmt.Errorf("restore snapshot for %q: %w", name, err)
		}
		return 0, fmt.Errorf("restore snapshot for slot %s: %w", restoreID, err)
	}
	if expected != nil && !sameSelectedRestoreSession(*expected, session, scope, restoreID) {
		return 0, errors.New("selected restore slot changed after confirmation; select it again")
	}
	label := fmt.Sprintf("slot %s", restoreID)
	if name != "" {
		label = fmt.Sprintf("%q", name)
	}
	if err := requireRestoreOwnerStopped(session.Owner); err != nil {
		return 0, fmt.Errorf("cannot restore %s while its original launcher may still be active: %w", label, err)
	}
	if err := requireRestoreOwnerStopped(session.AgentOwner); err != nil {
		return 0, fmt.Errorf("cannot restore %s while its original OMP process may still be active: %w", label, err)
	}
	if !filepath.IsAbs(extensionPath) {
		return 0, errors.New("OMP extension path must be absolute")
	}
	args := append([]string(nil), session.ResumeArgs...)
	args = append(args, "-r", session.SessionFile)
	if !isInteractiveLaunch(args) || isReservedCommand(args) {
		return 0, errors.New("saved launch options do not describe an interactive OMP session")
	}
	if !hasTerminal {
		if name != "" {
			return 0, errors.New("named restore requires an interactive terminal")
		}
		return 0, errors.New("slot restore requires an interactive terminal")
	}

	previousCWD, err := os.Getwd()
	if err != nil {
		return 0, fmt.Errorf("read current working directory before restore: %w", err)
	}
	if err := os.Chdir(session.CWD); err != nil {
		return 0, fmt.Errorf("change to saved working directory %q: %w", session.CWD, err)
	}
	defer func() { _ = os.Chdir(previousCWD) }()

	restoreEnvironment, err := anchorRestoreEnvironment(session.Scope)
	if err != nil {
		return 0, err
	}
	defer restoreEnvironment()

	return launchSession(args, extensionPath, session.RestoreID, lock)
}

func sameSelectedRestoreSession(expected, current protocol.SavedSession, scope protocol.Scope, restoreID string) bool {
	return expected.Version == 1 && expected.RestoreID == restoreID && expected.Scope == scope &&
		expected.SessionID == current.SessionID && expected.SessionFile == current.SessionFile &&
		expected.CWD == current.CWD && expected.Scope == current.Scope &&
		slices.Equal(expected.ResumeArgs, current.ResumeArgs)
}

func ensureRestoreDirectories(scope protocol.Scope) (restoreDirectories, error) {
	if !validScopeID(scope.ID) || !restoreProfilePattern.MatchString(scope.Profile) ||
		!filepath.IsAbs(scope.ConfigRoot) || filepath.Clean(scope.ConfigRoot) != scope.ConfigRoot ||
		!filepath.IsAbs(scope.AgentDir) || filepath.Clean(scope.AgentDir) != scope.AgentDir {
		return restoreDirectories{}, errors.New("invalid restore scope")
	}
	directories := restoreDirectories{
		root:        filepath.Join(scope.AgentDir, "instance-control", "restore"),
		snapshots:   filepath.Join(scope.AgentDir, "instance-control", "restore", "snapshots"),
		names:       filepath.Join(scope.AgentDir, "instance-control", "restore", "names"),
		checkpoints: filepath.Join(scope.AgentDir, "instance-control", "restore", "checkpoints"),
	}
	for _, directory := range []string{directories.root, directories.snapshots, directories.names, directories.checkpoints} {
		if err := EnsurePrivateDirectory(directory); err != nil {
			return restoreDirectories{}, fmt.Errorf("prepare private restore directory %q: %w", directory, err)
		}
	}
	return directories, nil
}

func readSavedSession(directories restoreDirectories, scope protocol.Scope, restoreID string, validateFiles bool) (protocol.SavedSession, error) {
	if !validInstanceID(restoreID) {
		return protocol.SavedSession{}, errors.New("invalid restore ID")
	}
	file := filepath.Join(directories.snapshots, restoreID+".json")
	var session protocol.SavedSession
	if err := readRestoreJSON(file, &session); err != nil {
		return protocol.SavedSession{}, err
	}
	if err := validateSavedSession(session, scope, restoreID, validateFiles); err != nil {
		return protocol.SavedSession{}, err
	}
	return session, nil
}

func validateSavedSession(session protocol.SavedSession, scope protocol.Scope, restoreID string, validateFiles bool) error {
	if session.Version != 1 || session.RestoreID != restoreID || session.Scope != scope {
		return errors.New("snapshot version, restore ID, or scope does not match")
	}
	if session.SessionID == "" || len(session.SessionID) > 512 {
		return errors.New("snapshot has an invalid session ID")
	}
	if len(session.ResumeArgs) > 512 {
		return errors.New("snapshot contains too many resume arguments")
	}
	if session.ResumeArgs == nil {
		return errors.New("snapshot resume arguments must be an array")
	}
	argumentBytes := 0
	for _, argument := range session.ResumeArgs {
		if strings.ContainsRune(argument, '\x00') {
			return errors.New("snapshot resume arguments contain a NUL byte")
		}
		argumentBytes += len(argument)
		if argumentBytes > maxRestorePayloadBytes/2 {
			return errors.New("snapshot resume arguments exceed the size limit")
		}
	}
	if err := validateRestoreOwner(session.Owner); err != nil {
		return fmt.Errorf("invalid snapshot owner: %w", err)
	}
	if err := validateRestoreOwner(session.AgentOwner); err != nil {
		return fmt.Errorf("invalid snapshot agent owner: %w", err)
	}
	if _, err := time.Parse(time.RFC3339Nano, session.UpdatedAt); err != nil {
		return fmt.Errorf("invalid snapshot update time: %w", err)
	}
	if !filepath.IsAbs(session.CWD) || filepath.Clean(session.CWD) != session.CWD {
		return errors.New("snapshot working directory is not a normalized absolute path")
	}
	if !filepath.IsAbs(session.SessionFile) || filepath.Clean(session.SessionFile) != session.SessionFile {
		return errors.New("snapshot session file is not a normalized absolute path")
	}
	if validateFiles {
		if err := validateRestorePath(session.CWD, true); err != nil {
			return fmt.Errorf("saved working directory is missing or unsafe: %w", err)
		}
		if err := validateRestorePath(session.SessionFile, false); err != nil {
			return fmt.Errorf("saved session file is missing or unsafe: %w", err)
		}
	}

	normalizedArgs, profile, cwd, err := restartArguments(session.ResumeArgs, session.CWD, nil)
	if err != nil {
		return fmt.Errorf("snapshot launch options are unsafe: %w", err)
	}
	if !slices.Equal(normalizedArgs, session.ResumeArgs) || cwd != session.CWD {
		return errors.New("snapshot launch options are not safely normalized or include a startup prompt")
	}
	if profile != "" && strings.TrimSpace(profile) != session.Scope.Profile {
		return errors.New("snapshot launch options select a different OMP profile")
	}
	return nil
}

func validateRestorePath(path string, directory bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("path is a symbolic link")
	}
	if directory && !info.IsDir() {
		return errors.New("path is not a directory")
	}
	if !directory && !info.Mode().IsRegular() {
		return errors.New("path is not a regular file")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	if resolved != path {
		return errors.New("path resolves through a symbolic link")
	}
	if !directory {
		uid, err := fileOwnerUID(info)
		if err != nil {
			return err
		}
		if uid != uint32(os.Getuid()) {
			return errors.New("session file is not owned by the current user")
		}
	}
	return nil
}

func validateRestoreOwner(owner protocol.RestoreOwner) error {
	if len(owner.BootID) != 36 || owner.PID <= 0 {
		return errors.New("boot ID or PID is invalid")
	}
	for index, character := range owner.BootID {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return errors.New("boot ID is invalid")
			}
			continue
		}
		if !strings.ContainsRune("0123456789abcdef", character) {
			return errors.New("boot ID is invalid")
		}
	}
	startTime, err := strconv.ParseUint(owner.StartTime, 10, 64)
	if err != nil || strconv.FormatUint(startTime, 10) != owner.StartTime {
		return errors.New("process start time is invalid")
	}
	return nil
}

func readRestoreName(directories restoreDirectories, name string) (restoreNameRecord, error) {
	if err := protocol.ValidateRestoreName(name); err != nil {
		return restoreNameRecord{}, err
	}
	var record restoreNameRecord
	file := filepath.Join(directories.names, name+".json")
	if err := readRestoreJSON(file, &record); err != nil {
		return restoreNameRecord{}, err
	}
	if record.Version != 1 || !validInstanceID(record.RestoreID) {
		return restoreNameRecord{}, errors.New("saved restore name has an invalid version or restore ID")
	}
	return record, nil
}

func readRestoreJSON(file string, value any) error {
	handle, err := os.OpenFile(file, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > maxRestorePayloadBytes {
		return fmt.Errorf("unsafe or oversized restore file %q", file)
	}
	uid, err := fileOwnerUID(info)
	if err != nil {
		return err
	}
	if uid != uint32(os.Getuid()) || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("restore file %q is not private to the current user", file)
	}
	encoded, err := io.ReadAll(io.LimitReader(handle, maxRestorePayloadBytes+1))
	if err != nil {
		return err
	}
	if len(encoded) > maxRestorePayloadBytes {
		return fmt.Errorf("restore file %q exceeds the size limit", file)
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

func createImmutableRestoreName(directories restoreDirectories, name, restoreID string) error {
	encoded, err := json.Marshal(restoreNameRecord{Version: 1, RestoreID: restoreID})
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return fmt.Errorf("generate private name temporary: %w", err)
	}
	temporary := filepath.Join(directories.names, ".restore-name-"+hex.EncodeToString(random[:])+".tmp")
	handle, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if err := writeAll(handle, encoded); err != nil {
		_ = handle.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := handle.Sync(); err != nil {
		_ = handle.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := handle.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	defer os.Remove(temporary)
	namePath := filepath.Join(directories.names, name+".json")
	if err := os.Link(temporary, namePath); err != nil {
		return err
	}
	return nil
}

func lockRestoreSnapshot(directories restoreDirectories, restoreID string) (*os.File, error) {
	if !validInstanceID(restoreID) {
		return nil, errors.New("invalid restore ID for snapshot lock")
	}
	file := filepath.Join(directories.snapshots, restoreID+".lock")
	handle, err := os.OpenFile(file, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open restore lock: %w", err)
	}
	info, err := handle.Stat()
	if err != nil {
		_ = handle.Close()
		return nil, err
	}
	uid, err := fileOwnerUID(info)
	if err != nil || !info.Mode().IsRegular() || uid != uint32(os.Getuid()) || info.Mode().Perm()&0o077 != 0 {
		_ = handle.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("restore lock is not a private regular file")
	}
	if err := syscall.Flock(int(handle.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = handle.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, errors.New("another restore of this saved session is already in progress")
		}
		return nil, fmt.Errorf("lock saved session for restore: %w", err)
	}
	return handle, nil
}

func closeRestoreLock(handle *os.File) {
	_ = handle.Close()
}

func requireRestoreOwnerStopped(owner protocol.RestoreOwner) error {
	if err := validateRestoreOwner(owner); err != nil {
		return fmt.Errorf("owner identity is uncertain: %w", err)
	}
	currentBootID, err := readBootID()
	if err != nil {
		return fmt.Errorf("owner identity is uncertain because the current boot ID could not be read: %w", err)
	}
	if currentBootID != owner.BootID {
		return nil
	}
	startTime, err := readProcessStartTime(owner.PID)
	if err == nil {
		if startTime == owner.StartTime {
			return fmt.Errorf("process PID %d is still running", owner.PID)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("owner identity is uncertain for PID %d: %w", owner.PID, err)
	}
	if err := syscall.Kill(owner.PID, 0); errors.Is(err, syscall.ESRCH) {
		return nil
	} else if err != nil {
		return fmt.Errorf("owner identity is uncertain for PID %d: %w", owner.PID, err)
	}
	return fmt.Errorf("owner identity is uncertain: PID %d exists but its process start time cannot be read", owner.PID)
}

func readBootID() (string, error) {
	encoded, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	bootID := strings.TrimSpace(string(encoded))
	if len(bootID) != 36 {
		return "", errors.New("Linux boot ID has an unexpected format")
	}
	return bootID, nil
}

func readProcessStartTime(pid int) (string, error) {
	if pid <= 0 {
		return "", errors.New("PID must be positive")
	}
	encoded, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", err
	}
	closingCommand := bytes.LastIndexByte(encoded, ')')
	if closingCommand < 0 || closingCommand+1 >= len(encoded) {
		return "", errors.New("process stat record is malformed")
	}
	fields := strings.Fields(string(encoded[closingCommand+1:]))
	if len(fields) <= 19 {
		return "", errors.New("process stat record is incomplete")
	}
	startTime := fields[19]
	if _, err := strconv.ParseUint(startTime, 10, 64); err != nil {
		return "", errors.New("process start time is malformed")
	}
	return startTime, nil
}

func anchorRestoreEnvironment(scope protocol.Scope) (func(), error) {
	updates := map[string]string{
		"OMP_PROFILE":   scope.Profile,
		"PI_CONFIG_DIR": scope.ConfigRoot,
	}
	if scope.Profile == "default" {
		updates["PI_CODING_AGENT_DIR"] = scope.AgentDir
	}
	previous := make(map[string]struct {
		value  string
		exists bool
	}, len(updates))
	for name := range updates {
		value, exists := os.LookupEnv(name)
		previous[name] = struct {
			value  string
			exists bool
		}{value: value, exists: exists}
	}
	for name, value := range updates {
		if err := os.Setenv(name, value); err != nil {
			restoreEnvironmentValues(previous)
			return nil, fmt.Errorf("anchor restore environment variable %s: %w", name, err)
		}
	}
	return func() { restoreEnvironmentValues(previous) }, nil
}

func restoreEnvironmentValues(previous map[string]struct {
	value  string
	exists bool
}) {
	for name, entry := range previous {
		if entry.exists {
			_ = os.Setenv(name, entry.value)
		} else {
			_ = os.Unsetenv(name)
		}
	}
}
