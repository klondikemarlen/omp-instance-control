package linux

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"unsafe"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const (
	launchDirectoryEnv = "OMP_INSTANCE_CONTROL_LAUNCH_DIR"
	launchTokenEnv     = "OMP_INSTANCE_CONTROL_LAUNCH_TOKEN"
	ompExecutableEnv   = "OMP_INSTANCE_CONTROL_OMP"
)

type launchRecord struct {
	Version       int                   `json:"version"`
	Token         string                `json:"token"`
	PID           int                   `json:"pid"`
	Scope         protocol.Scope        `json:"scope"`
	ExtensionPath string                `json:"extensionPath"`
	LastRestart   *restartRecord        `json:"lastRestart"`
	RestartError  string                `json:"restartError,omitempty"`
	BuiltinFlags  []string              `json:"builtinFlags"`
	RestoreID     string                `json:"restoreId"`
	ResumeArgs    []string              `json:"resumeArgs"`
	Owner         protocol.RestoreOwner `json:"owner"`
}

type restartRecord struct {
	OperationID        string `json:"operationId"`
	PreviousInstanceID string `json:"previousInstanceId"`
}

type handoffRecord struct {
	Version     int    `json:"version"`
	Token       string `json:"token"`
	OperationID string `json:"operationId"`
	InstanceID  string `json:"instanceId"`
	SessionFile string `json:"sessionFile"`
	CWD         string `json:"cwd"`
}

// Launch runs upstream OMP as a foreground child, loading the public control
// extension. OMP performs settlement and writes a one-shot restart handoff.
func Launch(args []string, extensionPath string) (int, error) {
	return launch(args, extensionPath, "", nil)
}

func launch(args []string, extensionPath, restoreID string, restoreLock *os.File) (int, error) {
	if !isInteractiveLaunch(args) || isReservedCommand(args) || !stdinIsTerminal() || !stdoutIsTerminal() {
		return runPassthrough(args)
	}
	if !filepath.IsAbs(extensionPath) {
		return 0, fmt.Errorf("extension path must be absolute: %s", extensionPath)
	}
	if _, err := os.Stat(extensionPath); err != nil {
		return 0, fmt.Errorf("cannot access OMP instance-control adapter %s: %w", extensionPath, err)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)

	initialCwd, err := os.Getwd()
	if err != nil {
		return 0, err
	}
	builtinFlags := make([]string, 0, len(args))
	restartArgs, profile, cwd, restartArgsErr := restartArguments(args, initialCwd, &builtinFlags)
	if err := ensureWorkingDirectory(cwd); err != nil {
		return 0, err
	}
	if restoreID == "" {
		restoreID, err = randomToken()
		if err != nil {
			return 0, err
		}
	}
	owner, err := NewRestoreOwner(os.Getpid())
	if err != nil {
		return 0, err
	}
	if restartArgs == nil {
		restartArgs = []string{}
	}
	scope, err := protocol.GetScope(profile, cwd)
	if err != nil {
		return 0, err
	}
	if restoreLock == nil {
		directories, err := ensureRestoreDirectories(scope)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Named restore unavailable: %v\n", err)
			restoreID = ""
		} else {
			restoreLock, err = lockRestoreSnapshot(directories, restoreID)
			if err != nil {
				return 0, err
			}
			// The child inherits this open-file description. Closing our reference
			// must not explicitly unlock a surviving child after launcher failure.
			defer restoreLock.Close()
		}
	}
	var inheritedFiles []*os.File
	if restoreLock != nil {
		inheritedFiles = []*os.File{restoreLock}
	}
	root, err := RuntimeRoot()
	if err != nil {
		return 0, err
	}
	if err := EnsurePrivateDirectory(root); err != nil {
		return 0, err
	}
	directoryToken, err := randomToken()
	if err != nil {
		return 0, err
	}
	launchDir := filepath.Join(root, "launch-"+directoryToken)
	if err := os.Mkdir(launchDir, 0700); err != nil {
		return 0, err
	}
	defer os.RemoveAll(launchDir)
	if err := EnsurePrivateDirectory(launchDir); err != nil {
		return 0, err
	}

	launchPath := filepath.Join(launchDir, "launch.json")
	handoffPath := filepath.Join(launchDir, "handoff.json")
	executable := os.Getenv(ompExecutableEnv)
	if executable == "" {
		executable = "omp"
	}
	var restart *restartRecord
	baseEnv := os.Environ()
	if scope.Profile == "default" && os.Getenv("PI_CODING_AGENT_DIR") != "" {
		baseEnv = replaceEnvironment(baseEnv, map[string]string{
			"PI_CODING_AGENT_DIR": scope.AgentDir,
		})
	}
	extensionFlag := "-e"
	if slices.Contains(builtinFlags, "trusted-extension") {
		extensionFlag = "--trusted-extension"
	}
	var resumeFile string
	for {
		select {
		case received := <-signals:
			return 128 + int(received.(syscall.Signal)), nil
		default:
		}
		token, err := randomToken()
		if err != nil {
			return 1, err
		}
		launch := launchRecord{
			Version: 1, Token: token, PID: os.Getpid(), Scope: scope,
			ExtensionPath: extensionPath, LastRestart: restart, BuiltinFlags: builtinFlags,
			RestoreID: restoreID, ResumeArgs: restartArgs, Owner: owner,
		}
		if restartArgsErr != nil && restart == nil {
			launch.RestartError = restartArgsErr.Error()
		}
		if err := os.Remove(handoffPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return 1, err
		}
		if err := WritePrivateJSON(launchPath, launch); err != nil {
			return 1, err
		}

		currentArgs := args
		if resumeFile != "" {
			currentArgs = restartArgs
		}
		childArgs := make([]string, 0, len(currentArgs)+4)
		if extensionFlag == "-e" {
			childArgs = append(childArgs, extensionFlag, extensionPath)
		} else {
			childArgs = append(childArgs, extensionFlag+"="+extensionPath)
		}
		childArgs = append(childArgs, currentArgs...)
		if resumeFile != "" {
			childArgs = append(childArgs, "-r", resumeFile)
		}
		childEnv := replaceEnvironment(baseEnv, map[string]string{
			launchDirectoryEnv: launchDir,
			launchTokenEnv:     token,
		})
		childCWD := initialCwd
		if resumeFile != "" {
			childCWD = cwd
		}
		child, err := runChild(executable, childArgs, childCWD, childEnv, signals, inheritedFiles)
		if err != nil {
			return 1, err
		}
		// Reap first: registrations are eligible for cleanup only after cmd.Wait completes.
		if !child.reaped {
			return 1, errors.New("OMP child completion was not verified")
		}
		if err := cleanupLaunchRegistrations(launchDir, token, scope, child.pid); err != nil {
			return 1, err
		}
		if child.signaled || child.code != 0 {
			return child.code, nil
		}
		if restartArgsErr != nil {
			return 0, nil
		}
		handoff, err := readHandoff(handoffPath, token)
		if errors.Is(err, fs.ErrNotExist) {
			return 0, nil
		}
		if err != nil {
			return 1, err
		}
		if err := validateHandoff(handoff); err != nil {
			return 1, err
		}
		if err := os.Remove(handoffPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return 1, err
		}
		if err := validateSessionAndCWD(handoff.SessionFile, handoff.CWD); err != nil {
			return 1, err
		}
		cwd = handoff.CWD
		restart = &restartRecord{OperationID: handoff.OperationID, PreviousInstanceID: handoff.InstanceID}
		resumeFile = handoff.SessionFile
	}
}

func runPassthrough(args []string) (int, error) {
	executable := os.Getenv(ompExecutableEnv)
	if executable == "" {
		executable = "omp"
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	result, err := runChild(executable, args, "", os.Environ(), signals, nil)
	return result.code, err
}

func isInteractiveLaunch(args []string) bool {
	positional := ""
	literal := false
	interactive := true
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if literal {
			continue
		}
		if arg == "--" {
			literal = true
			continue
		}
		if !strings.HasPrefix(arg, "-") {
			if positional == "" {
				positional = arg
			}
			continue
		}
		name, _, hasInline := splitFlag(arg)
		if name == "--print" || name == "-p" || name == "--print-thoughts" ||
			name == "--version" || name == "-v" || name == "--help" || name == "-h" ||
			name == "--mode" || name == "--no-extensions" {
			interactive = false
		}
		kind := flagValueKind(name)
		if !hasInline && i+1 < len(args) && (kind == valueRequired || kind == valueOptional || kind == valuePlan) {
			if kind == valueRequired || !strings.HasPrefix(args[i+1], "-") {
				i++
			}
		}
	}
	return interactive && !isStandardSubcommand(positional)
}

func isStandardSubcommand(value string) bool {
	switch value {
	case "launch", "help", "acp", "auth-broker", "auth-gateway", "agents", "bench", "browser-relay", "cleanse", "collab", "commit", "completions", "__complete", "compress", "config", "dry-balance", "find", "gc", "grep", "gallery", "git", "grievances", "images", "img", "if-bench", "install", "join", "login", "models", "plugin", "plugins", "predict", "ps", "say", "clip", "play", "share", "setup", "shell", "read", "render", "skill", "skills", "ssh", "stats", "stream", "update", "usage", "tiny-models", "token", "toks", "ttsr", "worktree", "wt", "search", "q", "web-search":
		return true
	default:
		return false
	}
}

var (
	stdinIsTerminal  = func() bool { return fileIsTerminal(os.Stdin) }
	stdoutIsTerminal = func() bool { return fileIsTerminal(os.Stdout) }
)

func fileIsTerminal(file *os.File) bool {
	var state syscall.Termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), uintptr(syscall.TCGETS), uintptr(unsafe.Pointer(&state)))
	return errno == 0
}

func ensureWorkingDirectory(cwd string) error {
	info, err := os.Stat(cwd)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("working directory is not a directory: %s", cwd)
	}
	return nil
}

func randomToken() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate launch token: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func replaceEnvironment(env []string, updates map[string]string) []string {
	result := make([]string, 0, len(env)+len(updates))
	for _, entry := range env {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			result = append(result, entry)
			continue
		}
		if _, replace := updates[key]; !replace {
			result = append(result, entry)
		}
	}
	for key, value := range updates {
		result = append(result, key+"="+value)
	}
	return result
}

type childResult struct {
	code     int
	signaled bool
	pid      int
	reaped   bool // True only after cmd.Wait completed; early runner errors leave it false.
}

func runChild(executable string, args []string, cwd string, env []string, signals <-chan os.Signal, inheritedFiles []*os.File) (childResult, error) {
	cmd := exec.Command(executable, args...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.ExtraFiles = inheritedFiles
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return childResult{code: 1}, err
	}
	childPID := cmd.Process.Pid
	childDone := make(chan error, 1)
	go func() { childDone <- cmd.Wait() }()
	for {
		select {
		case err := <-childDone:
			select {
			case received := <-signals:
				return childResult{
					code: 128 + int(received.(syscall.Signal)), signaled: true, pid: childPID, reaped: true,
				}, nil
			default:
			}
			if err == nil {
				return childResult{pid: childPID, reaped: true}, nil
			}
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
					return childResult{
						code: 128 + int(status.Signal()), signaled: true, pid: childPID, reaped: true,
					}, nil
				}
				return childResult{code: exitErr.ExitCode(), pid: childPID, reaped: true}, nil
			}
			return childResult{code: 1, pid: childPID, reaped: true}, err
		case received := <-signals:
			signal := received.(syscall.Signal)
			if err := cmd.Process.Signal(signal); err != nil && !errors.Is(err, os.ErrProcessDone) {
				return childResult{code: 1, pid: childPID}, err
			}
			waitErr := <-childDone
			if waitErr != nil {
				var exitErr *exec.ExitError
				if !errors.As(waitErr, &exitErr) {
					return childResult{code: 1, pid: childPID}, waitErr
				}
			}
			return childResult{code: 128 + int(signal), signaled: true, pid: childPID, reaped: true}, nil
		}
	}
}

func validateHandoff(handoff handoffRecord) error {
	request := protocol.Request{
		Version: handoff.Version, InstanceID: handoff.InstanceID,
		RequestID: handoff.OperationID, Action: "restart",
	}
	if protocol.ValidateRequest(request) != nil || !filepath.IsAbs(handoff.SessionFile) || !filepath.IsAbs(handoff.CWD) {
		return errors.New("invalid restart handoff; refusing to resume")
	}
	return nil
}

func readHandoff(path, token string) (handoffRecord, error) {
	var handoff handoffRecord
	info, err := os.Lstat(path)
	if err != nil {
		return handoff, err
	}
	if info.Size() > 16*1024 {
		return handoff, errors.New("restart handoff exceeds the size limit")
	}
	if err := ReadPrivateJSON(path, &handoff); err != nil {
		return handoff, err
	}
	if handoff.Token != token {
		return handoff, errors.New("restart handoff token does not match this launch")
	}
	return handoff, nil
}

func validToken(token string) bool {
	if len(token) != 32 {
		return false
	}
	_, err := hex.DecodeString(token)
	return err == nil && strings.ToLower(token) == token
}

func validateSessionAndCWD(sessionFile, cwd string) error {
	sessionInfo, err := os.Stat(sessionFile)
	if err != nil {
		return err
	}
	if !sessionInfo.Mode().IsRegular() {
		return errors.New("restart handoff session is not a regular file")
	}
	cwdInfo, err := os.Stat(cwd)
	if err != nil {
		return err
	}
	if !cwdInfo.IsDir() {
		return errors.New("restart handoff working directory is not a directory")
	}
	return nil
}

func isReservedCommand(args []string) bool {
	args = withoutProfileOptions(args)
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "extensions", "list", "remove", "uninstall", "marketplace", "discover", "upgrade", "enable", "disable":
	default:
		return false
	}
	if len(args) == 1 {
		return true
	}
	if args[0] == "marketplace" {
		switch args[1] {
		case "add", "remove", "rm", "update", "list":
			return true
		}
	}
	for _, arg := range args[1:] {
		if !strings.HasPrefix(arg, "-") && strings.Contains(arg, "@") {
			return true
		}
	}
	return false
}

func withoutProfileOptions(args []string) []string {
	var stripped []string
	start := 0
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			break
		}
		name, _, hasInline := splitFlag(arg)
		if name == "--profile" || name == "--alias" {
			if stripped == nil {
				stripped = make([]string, 0, len(args))
			}
			stripped = append(stripped, args[start:index]...)
			if !hasInline && index+1 < len(args) {
				index++
			}
			start = index + 1
			continue
		}
		if hasInline || index+1 == len(args) {
			continue
		}
		kind := flagValueKind(name)
		next := args[index+1]
		if kind == valueRequired || (kind == valueOptional || kind == valuePlan || kind == valueUnknown) && !strings.HasPrefix(next, "-") {
			index++
		}
	}
	if stripped == nil {
		return args
	}
	return append(stripped, args[start:]...)
}
