package linux

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const testPRResumeURL = "https://github.com/example/project/pull/116"

func TestLaunchPullRequestSendsOneShotRequestToManagedChild(t *testing.T) {
	root := t.TempDir()
	logPath := filepath.Join(root, "invocations.jsonl")
	session := filepath.Join(root, "conversation.jsonl")
	if err := os.WriteFile(session, nil, 0600); err != nil {
		t.Fatal(err)
	}
	prepareFakeOMP(t, root, logPath, session, root, "valid")
	changeDirectory(t, root)
	initialOverlay := filepath.Join(root, "operator.yml")
	t.Setenv("PI_CONFIG_FILES", initialOverlay)
	t.Setenv("OMPI_TEST_PR_RESUME_INITIAL_CONFIG", initialOverlay)
	t.Setenv("OMPI_TEST_PR_RESUME_STATUS", "resumed")

	adapter := filepath.Join(root, "adapter.js")
	code, err := LaunchPullRequest(testPRResumeURL, "work", adapter, "test")

	if err != nil || code != 0 {
		t.Fatalf("LaunchPullRequest returned code=%d err=%v", code, err)
	}
	calls := readInvocations(t, logPath)
	if len(calls) != 2 {
		t.Fatalf("expected initial child and subsequent restart, got %d launches", len(calls))
	}
	if want := []string{"-e", adapter, "--profile=work"}; !reflect.DeepEqual(calls[0].Args, want) {
		t.Fatalf("initial argv = %q; want %q", calls[0].Args, want)
	}
	wantRequest := map[string]any{
		"url": testPRResumeURL,
		"cwd": root,
	}
	if got := calls[0].Launch["prResume"]; !reflect.DeepEqual(got, wantRequest) {
		t.Fatalf("initial PR resume request = %#v; want %#v", got, wantRequest)
	}
	if _, exists := calls[1].Launch["prResume"]; exists {
		t.Fatal("replacement replayed the PR resume request")
	}
}

func TestLaunchPullRequestRefusesRedirectedOutputWithoutStartingOMP(t *testing.T) {
	root := t.TempDir()
	logPath := filepath.Join(root, "invocations.jsonl")
	prepareFakeOMP(t, root, logPath, "", "", "")
	stdoutIsTerminal = func() bool { return false }

	code, err := LaunchPullRequest(testPRResumeURL, "", filepath.Join(root, "adapter.js"), "test")

	if code == 0 || err == nil || !strings.Contains(err.Error(), "requires an interactive terminal") {
		t.Fatalf("expected a terminal refusal, got code=%d err=%v", code, err)
	}
	if _, err := os.Stat(logPath); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("refusal unexpectedly invoked OMP: %v", err)
	}
}

func TestLaunchPullRequestDoesNotTreatCleanChildExitAsResume(t *testing.T) {
	root := t.TempDir()
	prepareFakeOMP(t, root, filepath.Join(root, "invocations.jsonl"), "", "", "")

	code, err := LaunchPullRequest(testPRResumeURL, "", filepath.Join(root, "adapter.js"), "test")

	if code == 0 || err == nil || !strings.Contains(err.Error(), "without reporting a PR resume result") {
		t.Fatalf("expected missing-result refusal, got code=%d err=%v", code, err)
	}
}

func privatePRLaunchDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ompi-pr-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func TestReadPRResumeResultRejectsAnotherLaunchToken(t *testing.T) {
	launchDir := privatePRLaunchDir(t)
	result := map[string]any{
		"version": 1,
		"token":   strings.Repeat("b", 32),
		"status":  "resumed",
	}
	if err := WritePrivateJSON(filepath.Join(launchDir, "pr-resume-result.json"), result); err != nil {
		t.Fatal(err)
	}

	err := readPRResumeResult(launchDir, strings.Repeat("a", 32))

	if err == nil || !strings.Contains(err.Error(), "does not match this launch") {
		t.Fatalf("expected a token mismatch, got %v", err)
	}
}

func TestReadPRResumeResultDoesNotTreatRefusalAsSuccess(t *testing.T) {
	launchDir := privatePRLaunchDir(t)
	token := strings.Repeat("a", 32)
	result := map[string]any{
		"version": 1,
		"token":   token,
		"status":  "refused",
	}
	if err := WritePrivateJSON(filepath.Join(launchDir, "pr-resume-result.json"), result); err != nil {
		t.Fatal(err)
	}

	err := readPRResumeResult(launchDir, token)

	if err == nil || err.Error() != "OMP refused to resume the PR conversation" {
		t.Fatalf("expected a refusal, got %v", err)
	}
}
