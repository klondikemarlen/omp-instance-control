package linux

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRestartArgumentsDropsStartupSourcesAndNormalizesPaths(t *testing.T) {
	initial := filepath.Join(t.TempDir(), "initial")
	selected := filepath.Join(initial, "project")
	args := []string{
		"--profile", "first", "--profile=second", "--cwd", "project",
		"--config", "settings.json", "--extension=./extensions/custom.js",
		"--session-dir", "sessions", "--system-prompt-template", "prompts/base.txt",
		"--resume", "old-session", "--continue", "--fork", "fork-id", "--goal", "initial goal",
		"first prompt", "--", "literal prompt",
	}
	got, profile, cwd, err := restartArguments(args, initial, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"--profile", "first", "--profile=second", "--cwd", selected,
		"--config", filepath.Join(selected, "settings.json"),
		"--extension=" + filepath.Join(selected, "extensions/custom.js"),
		"--session-dir", filepath.Join(selected, "sessions"),
		"--system-prompt-template", filepath.Join(selected, "prompts/base.txt"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("restart argv mismatch\n got: %#v\nwant: %#v", got, want)
	}
	if profile != "second" || cwd != selected {
		t.Fatalf("scope capture profile=%q cwd=%q", profile, cwd)
	}
}

func TestRestartArgumentsDoesNotTreatAliasAsProfile(t *testing.T) {
	_, profile, _, err := restartArguments([]string{"--alias", "command"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if profile != "" {
		t.Fatalf("command alias was mistaken for a profile: %q", profile)
	}
}

func TestRestartArgumentsConservativelyRejectsUnknownStringArity(t *testing.T) {
	_, _, _, err := restartArguments([]string{"--custom-flag", "startup prompt"}, t.TempDir(), nil)
	if err == nil || !strings.Contains(err.Error(), "--custom-flag") || !strings.Contains(err.Error(), "--custom=value") {
		t.Fatalf("expected explicit ambiguity explanation, got %v", err)
	}
	got, _, _, err := restartArguments([]string{"--custom-flag=value", "--no-tools", "prompt"}, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"--custom-flag=value", "--no-tools"}) {
		t.Fatalf("unexpected safe restart args: %#v", got)
	}
}

func TestNonInteractiveAndSubcommandArgumentsBypassLauncher(t *testing.T) {
	for _, args := range [][]string{
		{"--help"},
		{"--version"},
		{"-p", "startup prompt"},
		{"--mode", "json"},
		{"models", "list"},
		{"help"},
		{"--profile", "work", "update"},
	} {
		if isInteractiveLaunch(args) {
			t.Errorf("expected passthrough classification for %#v", args)
		}
	}
}

func TestRestartArgumentsKeepsFlagLookingValuesLiteral(t *testing.T) {
	args := []string{"--system-prompt", "--config", "--model", "MODEL"}
	got, _, _, err := restartArguments(args, "/initial", nil)
	if err != nil || !reflect.DeepEqual(got, args) {
		t.Fatalf("restart reinterpreted a literal flag value: got=%#v err=%v", got, err)
	}
}

func TestHandoffIdentifierUsesProtocolUTF16Boundary(t *testing.T) {
	handoff := handoffRecord{
		Version: 1, OperationID: strings.Repeat("é", 65),
		InstanceID: strings.Repeat("a", 32), SessionFile: "/session.jsonl", CWD: "/project",
	}
	if err := validateHandoff(handoff); err != nil {
		t.Fatalf("protocol-valid handoff ID was rejected: %v", err)
	}
	handoff.OperationID = strings.Repeat("😀", 65)
	if err := validateHandoff(handoff); err == nil {
		t.Fatal("handoff exceeded the protocol UTF-16 boundary")
	}
}

type fakeInvocation struct {
	Args       []string       `json:"args"`
	Token      string         `json:"token"`
	Launch     map[string]any `json:"launch"`
	CallNumber int            `json:"callNumber"`
}

func TestFakeOMPChild(t *testing.T) {
	if os.Getenv("OMPI_TEST_CHILD") != "1" {
		t.Skip("helper process only")
	}
	logPath := os.Getenv("OMPI_TEST_LOG")
	callPath := os.Getenv("OMPI_TEST_CALLS")
	callNumber := 0
	if bytes, err := os.ReadFile(callPath); err == nil {
		callNumber, _ = strconv.Atoi(strings.TrimSpace(string(bytes)))
	}
	callNumber++
	if err := os.WriteFile(callPath, []byte(strconv.Itoa(callNumber)), 0600); err != nil {
		t.Fatal(err)
	}
	args := os.Args
	for index, arg := range args {
		if arg == "--" {
			args = args[index+1:]
			break
		}
	}
	launchDir := os.Getenv(launchDirectoryEnv)
	launchBytes, err := os.ReadFile(filepath.Join(launchDir, "launch.json"))
	if err != nil {
		t.Fatal(err)
	}
	launch := make(map[string]any)
	if err := json.Unmarshal(launchBytes, &launch); err != nil {
		t.Fatal(err)
	}
	entry := fakeInvocation{Args: args, Token: os.Getenv(launchTokenEnv), Launch: launch, CallNumber: callNumber}
	encoded, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintln(file, string(encoded)); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("OMPI_TEST_BLOCK") == "1" {
		termination := make(chan os.Signal, 1)
		signal.Notify(termination, syscall.SIGTERM)
		defer signal.Stop(termination)
		if err := os.WriteFile(os.Getenv("OMPI_TEST_READY"), []byte("ready"), 0600); err != nil {
			t.Fatal(err)
		}
		<-termination
		return
	}
	if callNumber == 1 && os.Getenv("OMPI_TEST_HANDOFF") != "" {
		token := entry.Token
		if os.Getenv("OMPI_TEST_HANDOFF") == "invalid" {
			token = strings.Repeat("0", 32)
		}
		handoff := map[string]any{
			"version": 1, "token": token, "operationId": "operation-123",
			"instanceId":  strings.Repeat("a", 32),
			"sessionFile": os.Getenv("OMPI_TEST_SESSION"),
			"cwd":         os.Getenv("OMPI_TEST_CWD"),
		}
		handoffBytes, _ := json.Marshal(handoff)
		if err := os.WriteFile(filepath.Join(launchDir, "handoff.json"), append(handoffBytes, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLaunchFakeOMPResumesWithCurrentCWDAndNoPromptReplay(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "handoff-cwd")
	if err := os.Mkdir(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(root, "project")
	if err := os.Mkdir(project, 0700); err != nil {
		t.Fatal(err)
	}
	session := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(session, []byte("session"), 0600); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "invocations.jsonl")
	prepareFakeOMP(t, root, logPath, session, cwd, "valid")
	changeDirectory(t, root)
	code, err := Launch([]string{
		"--profile", "work", "--cwd", "project", "--config", "settings.json",
		"--system-prompt-template", "prompts/system.txt", "--resume", "old-session",
		"startup prompt", "--", "literal tail",
	}, filepath.Join(root, "adapter.js"))
	if err != nil || code != 0 {
		t.Fatalf("Launch returned code=%d err=%v", code, err)
	}
	calls := readInvocations(t, logPath)
	if len(calls) != 2 {
		t.Fatalf("expected two OMP launches, got %d", len(calls))
	}
	if !containsPair(calls[0].Args, "--config", "settings.json") || !contains(calls[0].Args, "startup prompt") || !contains(calls[0].Args, "literal tail") {
		t.Fatalf("first launch changed original arguments: %#v", calls[0].Args)
	}
	if calls[0].Launch["scope"].(map[string]any)["profile"] != "work" {
		t.Fatalf("launch scope did not preserve profile: %#v", calls[0].Launch)
	}
	if calls[0].Token == calls[1].Token || len(calls[0].Token) != 32 || len(calls[1].Token) != 32 {
		t.Fatalf("each OMP launch needs a fresh 32-hex token: %q %q", calls[0].Token, calls[1].Token)
	}
	second := calls[1].Args
	if contains(second, "startup prompt") || contains(second, "literal tail") || contains(second, "old-session") {
		t.Fatalf("restart replayed startup input: %#v", second)
	}
	if !containsPair(second, "--config", filepath.Join(root, "project", "settings.json")) || !containsPair(second, "--system-prompt-template", filepath.Join(root, "project", "prompts/system.txt")) {
		t.Fatalf("restart paths were not normalized against effective cwd: %#v", second)
	}
	if !containsPair(second, "--cwd", cwd) || !containsPair(second, "--resume", session) {
		t.Fatalf("restart did not use the handoff cwd/session: %#v", second)
	}
}

func TestLaunchRejectsInvalidHandoffWithoutSecondChild(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "handoff-cwd")
	if err := os.Mkdir(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	session := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(session, []byte("session"), 0600); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "invocations.jsonl")
	prepareFakeOMP(t, root, logPath, session, cwd, "invalid")
	code, err := Launch([]string{"--no-tools"}, filepath.Join(root, "adapter.js"))
	if err == nil || code != 1 {
		t.Fatalf("expected invalid handoff failure, got code=%d err=%v", code, err)
	}
	if calls := readInvocations(t, logPath); len(calls) != 1 {
		t.Fatalf("invalid handoff launched another child: %d calls", len(calls))
	}
}

func TestLaunchForwardsSignalAndDoesNotRestart(t *testing.T) {
	root := t.TempDir()
	logPath := filepath.Join(root, "invocations.jsonl")
	prepareFakeOMP(t, root, logPath, "", "", "")
	readyPath := filepath.Join(root, "ready")
	t.Setenv("OMPI_TEST_BLOCK", "1")
	t.Setenv("OMPI_TEST_READY", readyPath)
	type launchResult struct {
		code int
		err  error
	}
	done := make(chan launchResult, 1)
	go func() {
		code, err := Launch([]string{"--no-tools"}, filepath.Join(root, "adapter.js"))
		done <- launchResult{code: code, err: err}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(readyPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fake OMP did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	result := <-done
	if result.err != nil || result.code != 128+int(syscall.SIGTERM) {
		t.Fatalf("signal result code=%d err=%v", result.code, result.err)
	}
	if calls := readInvocations(t, logPath); len(calls) != 1 {
		t.Fatalf("signal-triggered child exit was restarted: %d calls", len(calls))
	}
}

func TestAmbiguousOptionDisablesRestartWithoutChangingFirstLaunch(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "handoff-cwd")
	if err := os.Mkdir(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	session := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(session, []byte("session"), 0600); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "invocations.jsonl")
	prepareFakeOMP(t, root, logPath, session, cwd, "valid")
	code, err := Launch([]string{"--custom-flag", "startup prompt"}, filepath.Join(root, "adapter.js"))
	if err != nil || code != 0 {
		t.Fatalf("Launch returned code=%d err=%v", code, err)
	}
	calls := readInvocations(t, logPath)
	if len(calls) != 1 || !containsPair(calls[0].Args, "--custom-flag", "startup prompt") {
		t.Fatalf("first launch changed ambiguous arguments or restarted: %#v", calls)
	}
	restartError, ok := calls[0].Launch["restartError"].(string)
	if !ok || !strings.Contains(restartError, "--custom-flag") || !strings.Contains(restartError, "--custom=value") {
		t.Fatalf("missing explicit restart limitation in launch record: %#v", calls[0].Launch)
	}
}

func prepareFakeOMP(t *testing.T, root, logPath, session, cwd, handoff string) {
	t.Helper()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	originalInput, originalOutput := stdinIsTerminal, stdoutIsTerminal
	stdinIsTerminal, stdoutIsTerminal = func() bool { return true }, func() bool { return true }
	t.Cleanup(func() { stdinIsTerminal, stdoutIsTerminal = originalInput, originalOutput })
	t.Setenv("XDG_RUNTIME_DIR", root)
	t.Setenv("OMP_INSTANCE_CONTROL_OMP", filepath.Join(root, "fake-omp"))
	t.Setenv("OMPI_TEST_CHILD", "1")
	t.Setenv("OMPI_TEST_LOG", logPath)
	t.Setenv("OMPI_TEST_CALLS", filepath.Join(root, "calls"))
	t.Setenv("OMPI_TEST_HANDOFF", handoff)
	t.Setenv("OMPI_TEST_SESSION", session)
	t.Setenv("OMPI_TEST_CWD", cwd)
	if err := os.WriteFile(filepath.Join(root, "adapter.js"), []byte(""), 0600); err != nil {
		t.Fatal(err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	wrapper := "#!/bin/sh\nexec " + shellQuote(binary) + " -test.run=TestFakeOMPChild -- \"$@\"\n"
	fakeExecutable := filepath.Join(root, "fake-omp")
	if err := os.WriteFile(fakeExecutable, []byte(wrapper), 0700); err != nil {
		t.Fatal(err)
	}
}

func changeDirectory(t *testing.T, directory string) {
	t.Helper()
	original, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(directory); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(original); err != nil {
			t.Error(err)
		}
	})
}

func readInvocations(t *testing.T, path string) []fakeInvocation {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var calls []fakeInvocation
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var call fakeInvocation
		if err := json.Unmarshal(scanner.Bytes(), &call); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, call)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return calls
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func containsPair(values []string, name, value string) bool {
	for index := 0; index+1 < len(values); index++ {
		if values[index] == name && values[index+1] == value {
			return true
		}
	}
	return false
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
