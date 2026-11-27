package linux

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

// The wrapper itself sets this marker after consuming a handoff. It only
// disables automatic resume for the new launch; it cannot request an exec.
const freshLaunchEnv = "OMP_INSTANCE_CONTROL_FRESH_LAUNCH"

// Keep the wire fields in sync with omp/fresh-launch.js.
type freshLaunchHandoff struct {
	Directory string `json:"directory"`
	Device    string `json:"device"`
	Inode     string `json:"inode"`
	SessionID string `json:"sessionId"`
	PID       int    `json:"pid"`
}

func validateFreshLaunchHandoff(handoff handoffRecord, child childResult) error {
	fresh := handoff.FreshLaunch
	if fresh == nil || !child.reaped || child.signal != 0 || child.code != 0 || child.pid <= 0 ||
		handoff.Version != protocol.Version || !validToken(handoff.OperationID) || !validToken(handoff.InstanceID) ||
		fresh.PID != child.pid || fresh.SessionID == "" ||
		handoff.CWD != "" || handoff.SessionFile != "" || handoff.RestartWrapper || handoff.NativeTarget != nil {
		return errors.New("invalid fresh-launch handoff; refusing to start another session")
	}
	return nil
}

func openFreshDirectory(fresh freshLaunchHandoff) (*os.File, error) {
	directory := fresh.Directory
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return nil, errors.New("invalid approved fresh-launch directory")
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil || resolved != directory {
		return nil, fmt.Errorf("approved fresh-launch directory is no longer available: %q", directory)
	}
	fd, err := syscall.Open(directory, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open approved fresh-launch directory %q: %w", directory, err)
	}
	var opened syscall.Stat_t
	if err := syscall.Fstat(fd, &opened); err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("inspect approved fresh-launch directory %q: %w", directory, err)
	}
	if strconv.FormatUint(uint64(opened.Dev), 10) != fresh.Device || strconv.FormatUint(opened.Ino, 10) != fresh.Inode {
		syscall.Close(fd)
		return nil, fmt.Errorf("approved fresh-launch directory changed after preparation: %q", directory)
	}
	return os.NewFile(uintptr(fd), directory), nil
}

func verifyFreshWrapper() (string, error) {
	const running = "/proc/self/exe"
	path, err := os.Readlink(running)
	if err != nil {
		return "", err
	}
	runningImage, err := os.Stat(running)
	if err != nil {
		return "", err
	}
	installedImage, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !os.SameFile(runningImage, installedImage) || runningImage.Mode()&(os.ModeSetuid|os.ModeSetgid) != 0 ||
		os.Getuid() != os.Geteuid() || os.Getgid() != os.Getegid() {
		return "", errors.New("the running wrapper no longer matches a usable unprivileged executable")
	}
	// An executable with file capabilities could gain privileges on re-exec.
	_, err = syscall.Getxattr(running, "security.capability", nil)
	if err == nil {
		return "", errors.New("the running wrapper has file capabilities")
	}
	if !errors.Is(err, syscall.ENODATA) && !errors.Is(err, syscall.ENOTSUP) {
		return "", err
	}
	return path, usableExecutable(running)
}

func freshLaunchEnvironment(scope protocol.Scope, executable, executableCWD, sourceCWD, directory string) ([]string, error) {
	if strings.ContainsRune(executable, filepath.Separator) {
		executable = absolutePath(executableCWD, executable)
	} else {
		// Resolve against the original supervisor environment before changing cwd.
		located, err := exec.LookPath(executable)
		if err != nil {
			return nil, fmt.Errorf("locate upstream OMP: %w", err)
		}
		executable = located
	}
	if !filepath.IsAbs(executable) {
		return nil, errors.New("upstream OMP did not resolve to an absolute executable")
	}
	if err := usableExecutable(executable); err != nil {
		return nil, fmt.Errorf("verify upstream OMP: %w", err)
	}
	updates := map[string]string{
		freshLaunchEnv:    "1",
		ompExecutableEnv:  executable,
		execStatePathEnv:  "",
		execStateTokenEnv: "",
		execStateLockEnv:  "",
		"OMP_PROFILE":     scope.Profile,
		"PI_PROFILE":      scope.Profile,
		"PWD":             directory,
	}
	// OMP resolves PI_CONFIG_DIR against HOME; preserve its original spelling.
	// Only an explicit default-profile agent path depends on the previous cwd.
	if scope.Profile == "default" && os.Getenv("PI_CODING_AGENT_DIR") != "" {
		updates["PI_CODING_AGENT_DIR"] = scope.AgentDir
	}
	if value := os.Getenv(ompConfigFilesEnv); value != "" {
		files := filepath.SplitList(value)
		for i, file := range files {
			if file != "" && file != "~" && !strings.HasPrefix(file, "~/") {
				absolute := absolutePath(sourceCWD, file)
				if strings.ContainsRune(absolute, os.PathListSeparator) {
					return nil, errors.New("cannot preserve the original config overlay path list")
				}
				files[i] = absolute
			}
		}
		updates[ompConfigFilesEnv] = strings.Join(files, string(os.PathListSeparator))
	}
	return replaceEnvironment(os.Environ(), updates), nil
}

func execFreshLaunch(fresh freshLaunchHandoff, scope protocol.Scope, executable, executableCWD, sourceCWD string) error {
	wrapper, err := verifyFreshWrapper()
	if err != nil {
		return fmt.Errorf("verify running native wrapper: %w", err)
	}
	directory, err := openFreshDirectory(fresh)
	if err != nil {
		return err
	}
	defer directory.Close()
	environment, err := freshLaunchEnvironment(scope, executable, executableCWD, sourceCWD, fresh.Directory)
	if err != nil {
		return err
	}
	if err := syscall.Fchdir(int(directory.Fd())); err != nil {
		return fmt.Errorf("enter approved fresh-launch directory %q: %w", fresh.Directory, err)
	}
	// Use the exact running native image, never a destination-PATH lookup. A
	// successful exec keeps this foreground supervisor in the same terminal.
	if err := execWrapperProcess("/proc/self/exe", []string{wrapper}, environment); err != nil {
		return fmt.Errorf("execute verified native wrapper: %w", err)
	}
	return errors.New("native wrapper returned without executing")
}
