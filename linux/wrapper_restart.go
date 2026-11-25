package linux

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const (
	execStatePathEnv  = "OMP_INSTANCE_CONTROL_EXEC_STATE"
	execStateTokenEnv = "OMP_INSTANCE_CONTROL_EXEC_TOKEN"
	execStateLockEnv  = "OMP_INSTANCE_CONTROL_EXEC_LOCK_FD"
	execStateFilename = "wrapper-exec.json"
)

type wrapperExecState struct {
	Version     int            `json:"version"`
	Token       string         `json:"token"`
	Scope       protocol.Scope `json:"scope"`
	Args        []string       `json:"args"`
	CWD         string         `json:"cwd"`
	SessionFile string         `json:"sessionFile"`
	Restart     restartRecord  `json:"restart"`
	RestoreID   string         `json:"restoreId"`
	LockFD      int            `json:"lockFd"`
}

type resumeState struct {
	cwd          string
	sessionFile  string
	restart      restartRecord
	recoveryFile string
	observer     restartObserver
}

func currentWrapperExecutable() (string, error) {
	candidate := os.Args[0]
	if candidate == "" {
		return "", errors.New("the current executable path is unavailable")
	}
	if !strings.ContainsRune(candidate, filepath.Separator) {
		found, err := exec.LookPath(candidate)
		if err != nil {
			return "", fmt.Errorf("locate current executable %q: %w", candidate, err)
		}
		candidate = found
	}
	absolute, err := filepath.Abs(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve current executable path: %w", err)
	}
	return filepath.Clean(absolute), nil
}

func usableExecutable(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return errors.New("not a regular executable file")
	}
	if err := syscall.Access(path, 1); err != nil {
		return err
	}
	return nil
}

var execWrapperProcess = syscall.Exec

func execWrapperReplacement(
	launchDir, executable string, scope protocol.Scope, args []string, cwd, sessionFile string,
	restart *restartRecord, restoreID string, restoreLock *os.File, nativeTarget *protocol.NativeTarget,
) error {
	if nativeTarget != nil {
		if err := protocol.ValidateNativeTarget(nativeTarget); err != nil {
			return fmt.Errorf("invalid installed native wrapper target: %w", err)
		}
	}
	// Keep the selected image open so a package replacement cannot change what exec sees.
	fd, err := syscall.Open(executable, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("cannot open installed native wrapper %q: %w", executable, err)
	}
	defer syscall.Close(fd)
	var image syscall.Stat_t
	if err := syscall.Fstat(fd, &image); err != nil {
		return fmt.Errorf("cannot inspect installed native wrapper %q: %w", executable, err)
	}
	if image.Mode&syscall.S_IFMT != syscall.S_IFREG || image.Mode&0o111 == 0 {
		return fmt.Errorf("cannot execute installed native wrapper %q: not a regular executable file", executable)
	}
	if nativeTarget != nil &&
		(strconv.FormatUint(uint64(image.Dev), 10) != nativeTarget.Device ||
			strconv.FormatUint(image.Ino, 10) != nativeTarget.Inode ||
			strconv.FormatInt(image.Size, 10) != nativeTarget.Size ||
			strconv.FormatInt(image.Mtim.Sec*1e9+image.Mtim.Nsec, 10) != nativeTarget.ModifiedNs) {
		return fmt.Errorf("cannot execute installed native wrapper %q: installed image changed after verification", executable)
	}
	if restoreID != "" && restoreLock == nil {
		return errors.New("cannot restart the native wrapper without its managed restore lock")
	}
	token, err := randomToken()
	if err != nil {
		return err
	}
	state := wrapperExecState{
		Version: 1, Token: token, Scope: scope, Args: args,
		CWD: cwd, SessionFile: sessionFile, Restart: *restart, RestoreID: restoreID,
	}
	oldDescriptorFlags := 0
	if restoreLock != nil {
		fd := restoreLock.Fd()
		state.LockFD = int(fd)
		flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, fd, uintptr(syscall.F_GETFD), 0)
		if errno != 0 {
			return fmt.Errorf("prepare restore lock for native wrapper restart: %w", errno)
		}
		oldDescriptorFlags = int(flags)
		if _, _, errno := syscall.Syscall(syscall.SYS_FCNTL, fd, uintptr(syscall.F_SETFD), flags&^uintptr(syscall.FD_CLOEXEC)); errno != 0 {
			return fmt.Errorf("preserve restore lock across native wrapper restart: %w", errno)
		}
		defer func() {
			_, _, _ = syscall.Syscall(syscall.SYS_FCNTL, fd, uintptr(syscall.F_SETFD), uintptr(oldDescriptorFlags))
		}()
	}
	statePath := filepath.Join(launchDir, execStateFilename)
	if err := WritePrivateJSON(statePath, state); err != nil {
		return fmt.Errorf("write private native wrapper restart state: %w", err)
	}
	updates := map[string]string{
		execStatePathEnv:  statePath,
		execStateTokenEnv: token,
		execStateLockEnv:  strconv.Itoa(state.LockFD),
	}
	if scope.Profile == "default" && os.Getenv("PI_CODING_AGENT_DIR") != "" {
		updates["PI_CODING_AGENT_DIR"] = scope.AgentDir
	}
	environment := replaceEnvironment(os.Environ(), updates)
	execPath := fmt.Sprintf("/proc/self/fd/%d", fd)
	if err := execWrapperProcess(execPath, []string{executable}, environment); err != nil {
		return fmt.Errorf("cannot execute installed native wrapper %q: %w", executable, err)
	}
	return nil
}

func resumeWrapper(args []string, extensionPath, nativeVersion string) (int, error) {
	if len(args) != 0 {
		return 1, errors.New("invalid native wrapper restart invocation")
	}
	state, lock, err := consumeWrapperExecState()
	if err != nil {
		if state.Restart.OperationID != "" {
			err = restartRecoveryFailure(existingRestartRecovery(state.Scope, state.Restart.OperationID), err)
		}
		return 1, err
	}
	if lock != nil {
		defer lock.Close()
	}
	return launchWithResume(
		state.Args, extensionPath, nativeVersion, state.RestoreID, lock,
		&resumeState{
			cwd:          state.CWD,
			sessionFile:  state.SessionFile,
			restart:      state.Restart,
			recoveryFile: existingRestartRecovery(state.Scope, state.Restart.OperationID),
			observer:     observeRestart(state.Scope, state.Restart),
		},
	)
}

type nativeImage struct {
	Executable string `json:"executable"`
	Version    string `json:"version"`
	Device     string `json:"device"`
	Inode      string `json:"inode"`
}

func nativeImageMetadata(executable, version string, executableErr error) *nativeImage {
	if executableErr != nil || executable == "" || version == "" {
		return nil
	}
	var image syscall.Stat_t
	if err := syscall.Stat("/proc/self/exe", &image); err != nil {
		return nil
	}
	return &nativeImage{
		Executable: executable,
		Version:    version,
		Device:     strconv.FormatUint(uint64(image.Dev), 10),
		Inode:      strconv.FormatUint(image.Ino, 10),
	}
}

func consumeWrapperExecState() (wrapperExecState, *os.File, error) {
	var state wrapperExecState
	statePath := os.Getenv(execStatePathEnv)
	token := os.Getenv(execStateTokenEnv)
	lockValue := os.Getenv(execStateLockEnv)
	_ = os.Unsetenv(execStatePathEnv)
	_ = os.Unsetenv(execStateTokenEnv)
	_ = os.Unsetenv(execStateLockEnv)
	if statePath == "" || !validToken(token) {
		return state, nil, errors.New("native wrapper restart state is missing or invalid")
	}
	runtimeRoot, err := RuntimeRoot()
	if err != nil {
		return state, nil, fmt.Errorf("validate native wrapper restart state: %w", err)
	}
	launchDir := filepath.Dir(statePath)
	directoryToken := strings.TrimPrefix(filepath.Base(launchDir), "launch-")
	if !filepath.IsAbs(statePath) || filepath.Clean(statePath) != statePath ||
		filepath.Base(statePath) != execStateFilename || filepath.Dir(launchDir) != runtimeRoot ||
		!validToken(directoryToken) {
		return state, nil, errors.New("native wrapper restart state path is unsafe")
	}
	if err := EnsurePrivateDirectory(runtimeRoot); err != nil {
		return state, nil, fmt.Errorf("validate native wrapper restart directory: %w", err)
	}
	if err := EnsurePrivateDirectory(launchDir); err != nil {
		return state, nil, fmt.Errorf("validate native wrapper restart directory: %w", err)
	}
	consumedPath := statePath + ".consumed"
	if err := os.Rename(statePath, consumedPath); err != nil {
		return state, nil, fmt.Errorf("native wrapper restart state was already consumed or is unavailable: %w", err)
	}
	defer os.RemoveAll(launchDir)
	info, err := os.Lstat(consumedPath)
	if err != nil {
		return state, nil, err
	}
	if info.Size() > 1<<20 {
		return state, nil, errors.New("native wrapper restart state exceeds the size limit")
	}
	if err := ReadPrivateJSON(consumedPath, &state); err != nil {
		return state, nil, fmt.Errorf("read native wrapper restart state: %w", err)
	}
	if err := os.Remove(consumedPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return state, nil, fmt.Errorf("consume native wrapper restart state: %w", err)
	}
	lockFD, err := strconv.Atoi(lockValue)
	if state.Version != 1 || state.Token != token {
		return state, nil, errors.New("native wrapper restart state identity is invalid")
	}
	if err != nil {
		observeWrapperStateFailure(state)
		return state, nil, errors.New("native wrapper restart state identity is invalid")
	}
	if err := validateWrapperExecState(state, lockFD); err != nil {
		observeWrapperStateFailure(state)
		return state, nil, fmt.Errorf("invalid native wrapper restart state: %w", err)
	}
	var lock *os.File
	if lockFD > 0 {
		lock = os.NewFile(uintptr(lockFD), "ompi restore lock")
		if lock == nil {
			observeWrapperStateFailure(state)
			return state, nil, errors.New("native wrapper restart restore lock descriptor is invalid")
		}
		syscall.CloseOnExec(lockFD)
	}
	return state, lock, nil
}

// A token-matched state still needs independent scope validation before it
// can select a diagnostics directory, even when the replacement cannot start.
func observeWrapperStateFailure(state wrapperExecState) {
	if !filepath.IsAbs(state.CWD) || filepath.Clean(state.CWD) != state.CWD ||
		!validWrapperRestartCorrelation(state.Restart) {
		return
	}
	scope, err := protocol.GetScope(state.Scope.Profile, state.CWD)
	if err != nil || scope != state.Scope {
		return
	}
	observeRestart(scope, state.Restart).observe("replacement-failed", "wrapper-state", nil, 0)
}

func validWrapperRestartCorrelation(restart restartRecord) bool {
	request := protocol.Request{
		Version:    protocol.Version,
		InstanceID: restart.PreviousInstanceID,
		RequestID:  restart.OperationID,
		Action:     "restart-wrapper",
	}
	return protocol.ValidateRequest(request) == nil
}

func validateWrapperExecState(state wrapperExecState, lockFD int) error {
	if state.Args == nil || !filepath.IsAbs(state.CWD) || filepath.Clean(state.CWD) != state.CWD ||
		!filepath.IsAbs(state.SessionFile) || filepath.Clean(state.SessionFile) != state.SessionFile {
		return errors.New("session, working directory, or safe argument state is invalid")
	}
	if err := validateSessionAndCWD(state.SessionFile, state.CWD); err != nil {
		return err
	}
	args, profile, cwd, err := restartArguments(state.Args, state.CWD, nil)
	if err != nil || !slices.Equal(args, state.Args) || cwd != state.CWD {
		return errors.New("safe launch arguments are invalid")
	}
	scope, err := protocol.GetScope(profile, cwd)
	if err != nil || scope != state.Scope {
		return errors.New("configuration scope changed during native wrapper restart")
	}
	if !validWrapperRestartCorrelation(state.Restart) {
		return errors.New("restart correlation is invalid")
	}
	if state.RestoreID == "" {
		if lockFD != 0 || state.LockFD != 0 {
			return errors.New("unexpected restore lock for a non-restorable launch")
		}
		return nil
	}
	if !validInstanceID(state.RestoreID) || lockFD <= 2 || state.LockFD != lockFD {
		return errors.New("managed restore identity or lock descriptor is invalid")
	}
	directories, err := ensureRestoreDirectories(state.Scope)
	if err != nil {
		return err
	}
	lockPath := filepath.Join(directories.snapshots, state.RestoreID+".lock")
	listed, err := os.Lstat(lockPath)
	if err != nil {
		return err
	}
	fdInfo, err := os.Stat(fmt.Sprintf("/proc/self/fd/%d", lockFD))
	if err != nil {
		return err
	}
	fdUID, err := fileOwnerUID(fdInfo)
	if err != nil || !fdInfo.Mode().IsRegular() || fdUID != uint32(os.Getuid()) || fdInfo.Mode().Perm()&0o077 != 0 {
		return errors.New("inherited restore lock is not a private regular file")
	}
	listedUID, err := fileOwnerUID(listed)
	if err != nil || listed.Mode()&os.ModeSymlink != 0 || !listed.Mode().IsRegular() ||
		listedUID != uint32(os.Getuid()) || listed.Mode().Perm()&0o077 != 0 || !os.SameFile(listed, fdInfo) {
		return errors.New("inherited restore lock does not match the managed restore slot")
	}
	if err := syscall.Flock(lockFD, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("restore lock ownership was not preserved: %w", err)
	}
	return nil
}
