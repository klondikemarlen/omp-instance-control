package protocol

// RecoveryCheckpoint records the managed restore slots selected at one point in
// time. Entries contain membership and display metadata, not transcript copies.
type RecoveryCheckpoint struct {
	Version      int                       `json:"version"`
	CheckpointID string                    `json:"checkpointId"`
	Scope        Scope                     `json:"scope"`
	BootID       string                    `json:"bootId"`
	CreatedAt    string                    `json:"createdAt"`
	Reason       string                    `json:"reason"`
	Entries      []RecoveryCheckpointEntry `json:"entries"`
	Legacy       []RecoveryLegacyEntry     `json:"legacy,omitempty"`
	SourcePath   string                    `json:"sourcePath,omitempty"`
	SourceSha256 string                    `json:"sourceSha256,omitempty"`
	Warnings     []string                  `json:"warnings,omitempty"`
}

// RecoveryCheckpointEntry identifies one managed slot in a checkpoint.
type RecoveryCheckpointEntry struct {
	RestoreID string `json:"restoreId"`
	SessionID string `json:"sessionId"`
	CWD       string `json:"cwd"`
}

// RecoveryLegacyEntry is imported legacy data, never a managed slot owner.
type RecoveryLegacyEntry struct {
	CWD         string `json:"cwd"`
	SessionID   string `json:"sessionId"`
	SessionFile string `json:"sessionFile,omitempty"`
	Unavailable string `json:"unavailable,omitempty"`
}

// RecoverySession is one selectable managed slot or review-only legacy entry.
type RecoverySession struct {
	RestoreID   string               `json:"restoreId,omitempty"`
	Name        string               `json:"name,omitempty"`
	Session     *SavedSession        `json:"session,omitempty"`
	Unavailable string               `json:"unavailable,omitempty"`
	Legacy      *RecoveryLegacyEntry `json:"legacy,omitempty"`
}
