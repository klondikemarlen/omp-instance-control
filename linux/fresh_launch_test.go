package linux

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const freshLaunchPID = 1234

func freshLaunchTestHandoff() handoffRecord {
	return handoffRecord{
		Version:     protocol.Version,
		Token:       strings.Repeat("1", 32),
		OperationID: strings.Repeat("2", 32),
		InstanceID:  strings.Repeat("3", 32),
		FreshLaunch: &freshLaunchHandoff{
			PID:       freshLaunchPID,
			SessionID: "approved-session",
		},
	}
}

func TestReadHandoffRefusesFreshLaunchFromAnotherLaunch(t *testing.T) {
	// Arrange
	handoff := freshLaunchTestHandoff()
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "handoff.json")
	if err := WritePrivateJSON(path, handoff); err != nil {
		t.Fatal(err)
	}

	// Act
	_, err := readHandoff(path, strings.Repeat("4", 32))

	// Assert
	if err == nil || !strings.Contains(err.Error(), "does not match this launch") {
		t.Fatalf("reading a marker from a different launch returned %v", err)
	}
}

func TestFreshLaunchAcceptsReapedMatchingChild(t *testing.T) {
	// Arrange
	handoff := freshLaunchTestHandoff()
	child := childResult{pid: freshLaunchPID, reaped: true}

	// Act
	err := validateFreshLaunchHandoff(handoff, child)

	// Assert
	if err != nil {
		t.Fatalf("rejected the correlated clean exit: %v", err)
	}
}

func TestFreshLaunchRejectsUnrelatedOrUnsuccessfulChildExit(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		child childResult
	}{
		{name: "different child", child: childResult{pid: freshLaunchPID + 1, reaped: true}},
		{name: "not reaped", child: childResult{pid: freshLaunchPID}},
		{name: "nonzero status", child: childResult{pid: freshLaunchPID, reaped: true, code: 1}},
		{name: "signal", child: childResult{pid: freshLaunchPID, reaped: true, signal: syscall.SIGTERM}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			// Arrange
			handoff := freshLaunchTestHandoff()

			// Act
			err := validateFreshLaunchHandoff(handoff, scenario.child)

			// Assert
			if err == nil {
				t.Fatal("accepted an unrelated or unsuccessful exit")
			}
		})
	}
}

func TestFreshLaunchRejectsSavedSessionTarget(t *testing.T) {
	// Arrange
	handoff := freshLaunchTestHandoff()
	handoff.SessionFile = filepath.Join(t.TempDir(), "old-session.jsonl")
	child := childResult{pid: freshLaunchPID, reaped: true}

	// Act
	err := validateFreshLaunchHandoff(handoff, child)

	// Assert
	if err == nil {
		t.Fatal("accepted a saved session in a fresh-launch handoff")
	}
}

func approvedFreshDirectory(t *testing.T) freshLaunchHandoff {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "project ; $(not a command)")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	var info syscall.Stat_t
	if err := syscall.Stat(directory, &info); err != nil {
		t.Fatal(err)
	}
	return freshLaunchHandoff{
		Directory: directory,
		Device:    strconv.FormatUint(uint64(info.Dev), 10),
		Inode:     strconv.FormatUint(info.Ino, 10),
	}
}

func TestFreshLaunchOpensTheApprovedDirectoryWithLiteralMetacharacters(t *testing.T) {
	// Arrange
	handoff := approvedFreshDirectory(t)
	approved, err := os.Stat(handoff.Directory)
	if err != nil {
		t.Fatal(err)
	}

	// Act
	directory, err := openFreshDirectory(handoff)

	// Assert
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	opened, err := directory.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(opened, approved) {
		t.Fatal("opened a different directory")
	}
}

func TestFreshLaunchRejectsRedirectThroughSymlink(t *testing.T) {
	// Arrange
	handoff := approvedFreshDirectory(t)
	moved := filepath.Join(filepath.Dir(handoff.Directory), "moved")
	if err := os.Rename(handoff.Directory, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moved, handoff.Directory); err != nil {
		t.Fatal(err)
	}

	// Act
	directory, err := openFreshDirectory(handoff)

	// Assert
	if err == nil {
		directory.Close()
		t.Fatal("accepted redirect through a symlink")
	}
}

func TestFreshLaunchRejectsADifferentDirectoryAtTheApprovedPath(t *testing.T) {
	// Arrange
	handoff := approvedFreshDirectory(t)
	moved := filepath.Join(filepath.Dir(handoff.Directory), "moved")
	if err := os.Rename(handoff.Directory, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(handoff.Directory, 0700); err != nil {
		t.Fatal(err)
	}

	// Act
	directory, err := openFreshDirectory(handoff)

	// Assert
	if err == nil {
		directory.Close()
		t.Fatal("accepted a different inode at the approved path")
	}
}

func TestFreshLaunchDoesNotResolveAnExecutableInTheDestination(t *testing.T) {
	// Arrange
	source := t.TempDir()
	destination := t.TempDir()
	if err := os.WriteFile(filepath.Join(destination, "target-only"), nil, 0700); err != nil {
		t.Fatal(err)
	}
	scope := protocol.Scope{Profile: "default"}

	// Act
	_, err := freshLaunchEnvironment(scope, "./target-only", source, source, destination)

	// Assert
	if err == nil {
		t.Fatal("found an executable that only exists in the approved destination")
	}
}

func TestFreshLaunchKeepsTheOriginalProfileConfigAndExecutableResolution(t *testing.T) {
	// Arrange
	source := t.TempDir()
	destination := t.TempDir()
	upstream := filepath.Join(source, "omp")
	if err := os.WriteFile(upstream, nil, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", source)
	t.Setenv("PI_CONFIG_DIR", ".custom-omp")
	t.Setenv("PI_CODING_AGENT_DIR", "")
	if err := os.Unsetenv("PI_CODING_AGENT_DIR"); err != nil {
		t.Fatal(err)
	}
	t.Setenv(ompConfigFilesEnv, "existing.yml")
	scope := protocol.Scope{
		Profile:    "default",
		ConfigRoot: filepath.Join(source, "config-root"),
		AgentDir:   filepath.Join(source, "agent-dir"),
	}
	want := map[string]string{
		ompExecutableEnv:  upstream,
		"OMP_PROFILE":     scope.Profile,
		"PI_CONFIG_DIR":   ".custom-omp",
		ompConfigFilesEnv: filepath.Join(source, "existing.yml"),
	}

	// Act
	environment, err := freshLaunchEnvironment(scope, "omp", source, source, destination)

	// Assert
	if err != nil {
		t.Fatal(err)
	}
	values := make(map[string]string)
	for _, entry := range environment {
		key, value, _ := strings.Cut(entry, "=")
		values[key] = value
	}
	for key, value := range want {
		if got := values[key]; got != value {
			t.Errorf("%s = %q, want %q", key, got, value)
		}
	}
	if _, added := values["PI_CODING_AGENT_DIR"]; added {
		t.Error("fresh launch added an agent directory override")
	}
}

func TestFreshLaunchAnchorsAnExistingDefaultProfileAgentDirectoryOverride(t *testing.T) {
	// Arrange
	source := t.TempDir()
	destination := t.TempDir()
	upstream := filepath.Join(source, "omp")
	if err := os.WriteFile(upstream, nil, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PI_CODING_AGENT_DIR", "custom-agent")
	scope := protocol.Scope{
		Profile:  "default",
		AgentDir: filepath.Join(source, "custom-agent"),
	}

	// Act
	environment, err := freshLaunchEnvironment(scope, upstream, source, source, destination)

	// Assert
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range environment {
		if value, ok := strings.CutPrefix(entry, "PI_CODING_AGENT_DIR="); ok && value == scope.AgentDir {
			return
		}
	}
	t.Fatalf("fresh launch did not retain the original agent directory %q", scope.AgentDir)
}

func TestFreshLaunchOverlayDisablesAutoResumeAfterInheritedConfig(t *testing.T) {
	// Arrange
	launch := t.TempDir()
	existing := filepath.Join(launch, "existing.yml")
	if err := os.WriteFile(existing, []byte("autoResume: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(ompConfigFilesEnv, existing)

	// Act
	overlays, err := writeNoAutoResumeOverlay(launch, "fresh-launch.yml")

	// Assert
	if err != nil {
		t.Fatal(err)
	}
	files := filepath.SplitList(overlays)
	if len(files) != 2 || files[0] != existing {
		t.Fatalf("settings list = %q; want existing settings followed by a fresh-launch overlay", overlays)
	}
	content, err := os.ReadFile(files[1])
	if err != nil || string(content) != "autoResume: false\n" {
		t.Fatalf("fresh-launch settings = %q, error = %v", content, err)
	}
}
