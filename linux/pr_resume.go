package linux

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const (
	ompConfigFilesEnv      = "PI_CONFIG_FILES"
	prResumeResultFilename = "pr-resume-result.json"
)

type prResumeRequest struct {
	URL string `json:"url"`
	CWD string `json:"cwd"`
}

type prResumeResult struct {
	Version int    `json:"version"`
	Token   string `json:"token"`
	Status  string `json:"status"`
}

// LaunchPullRequest lets the foreground OMP adapter request consent and acquire
// the exact conversation lease. It never passes a transcript or a model prompt.
func LaunchPullRequest(url, profile, extensionPath, nativeVersion string) (int, error) {
	var args []string
	if profile != "" {
		args = []string{"--profile=" + profile}
	}
	return launchManaged(args, extensionPath, nativeVersion, "", nil, nil, &prResumeRequest{
		URL: url,
	}, false)
}

func writeNoAutoResumeOverlay(launchDir, filename string) (string, error) {
	file := filepath.Join(launchDir, filename)
	if strings.ContainsRune(file, os.PathListSeparator) {
		return "", errors.New("cannot disable automatic session resume with this runtime directory; its path contains the config file list separator")
	}
	if err := os.WriteFile(file, []byte("autoResume: false\n"), 0600); err != nil {
		return "", fmt.Errorf("disable automatic session resume for this launch: %w", err)
	}
	overlays := os.Getenv(ompConfigFilesEnv)
	if overlays != "" {
		return overlays + string(os.PathListSeparator) + file, nil
	}
	return file, nil
}

func readPRResumeResult(launchDir, token string) error {
	file := filepath.Join(launchDir, prResumeResultFilename)
	info, err := os.Lstat(file)
	if errors.Is(err, fs.ErrNotExist) {
		return errors.New("OMP exited without reporting a PR resume result")
	}
	if err != nil {
		return fmt.Errorf("read OMP PR resume result: %w", err)
	}
	if info.Size() > 16*1024 {
		return errors.New("OMP PR resume result exceeds the size limit")
	}
	var result prResumeResult
	if err := ReadPrivateJSON(file, &result); err != nil {
		return fmt.Errorf("read OMP PR resume result: %w", err)
	}
	if result.Version != protocol.Version || result.Token != token {
		return errors.New("OMP PR resume result does not match this launch")
	}
	switch result.Status {
	case "resumed", "already-active":
		return nil
	case "cancelled":
		return errors.New("PR resume was cancelled")
	case "not-found":
		return errors.New("no saved PR conversation matched in this directory and scope")
	case "refused":
		return errors.New("OMP refused to resume the PR conversation")
	default:
		return errors.New("OMP returned an unknown PR resume result")
	}
}
