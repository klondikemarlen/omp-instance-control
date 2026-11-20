package protocol

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

const WorkClaimVersion = 1

// WorkClaim records one explicit work assertion for a saved conversation, not a launch.
type WorkClaim struct {
	Version     int    `json:"version"`
	Scope       string `json:"scope"`
	SessionID   string `json:"sessionId"`
	SessionFile string `json:"sessionFile"`
	CWD         string `json:"cwd"`
	URL         string `json:"url"`
	Summary     string `json:"summary"`
	Branch      string `json:"branch"`
	UpdatedAt   string `json:"updatedAt"`
}

var workURLPattern = regexp.MustCompile(`^https://github\.com/([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)/([a-zA-Z0-9._-]{1,100})/(issues|pull)/([1-9][0-9]{0,19})$`)

// NormalizeWorkURL accepts only a GitHub issue or pull request URL without extra URL syntax.
func NormalizeWorkURL(value string) (string, error) {
	match := workURLPattern.FindStringSubmatch(value)
	if match == nil || match[2] == "." || match[2] == ".." {
		return "", errors.New("work URL must be https://github.com/OWNER/REPO/issues/N or https://github.com/OWNER/REPO/pull/N")
	}
	if _, err := strconv.ParseUint(match[4], 10, 64); err != nil {
		return "", errors.New("work URL issue or pull request number is too large")
	}
	return "https://github.com/" + strings.ToLower(match[1]) + "/" + strings.ToLower(match[2]) + "/" + match[3] + "/" + match[4], nil
}
