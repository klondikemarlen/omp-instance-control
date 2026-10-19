package protocol

import (
	"errors"
	"regexp"
)

var restoreNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// RestoreOwner identifies one process instance across reboots and PID reuse.
type RestoreOwner struct {
	BootID    string `json:"bootId"`
	PID       int    `json:"pid"`
	StartTime string `json:"startTime"`
}

// SavedSession is a validated snapshot of one launcher-managed OMP session.
type SavedSession struct {
	Version     int          `json:"version"`
	RestoreID   string       `json:"restoreId"`
	Scope       Scope        `json:"scope"`
	SessionFile string       `json:"sessionFile"`
	SessionID   string       `json:"sessionId"`
	CWD         string       `json:"cwd"`
	ResumeArgs  []string     `json:"resumeArgs"`
	Owner       RestoreOwner `json:"owner"`
	AgentOwner  RestoreOwner `json:"agentOwner"`
	UpdatedAt   string       `json:"updatedAt"`
}

// NamedSession reports the current snapshot bound to one persistent wrapper slot.
type NamedSession struct {
	Name        string       `json:"name"`
	Session     SavedSession `json:"session,omitzero"`
	Unavailable string       `json:"unavailable,omitempty"`
}

// ValidateRestoreName checks the immutable restore-name namespace.
func ValidateRestoreName(name string) error {
	if !restoreNamePattern.MatchString(name) || name == "save" {
		return errors.New("restore name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} and cannot be 'save'")
	}
	return nil
}
