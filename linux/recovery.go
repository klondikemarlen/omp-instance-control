package linux

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const maxRecoveryCheckpointBytes = 1 << 20
const missingRecoverySnapshotReason = "No current persisted session snapshot exists for this managed slot."
const missingRecoveryPathReason = "The current session file or working directory is unavailable."

// ListRecoveryCheckpoints returns the immutable, retained checkpoint history for one scope.
func ListRecoveryCheckpoints(scope protocol.Scope) ([]protocol.RecoveryCheckpoint, error) {
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directories.checkpoints)
	if err != nil {
		return nil, fmt.Errorf("read recovery checkpoints: %w", err)
	}
	checkpoints := make([]protocol.RecoveryCheckpoint, 0, len(entries))
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		checkpointID := strings.TrimSuffix(entry.Name(), ".json")
		if !validInstanceID(checkpointID) {
			return nil, fmt.Errorf("invalid recovery checkpoint filename %q", entry.Name())
		}
		checkpoint, err := readRecoveryCheckpoint(directories, scope, checkpointID)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, fmt.Errorf("read recovery checkpoint %s: %w", checkpointID, err)
		}
		checkpoints = append(checkpoints, checkpoint)
	}
	sort.Slice(checkpoints, func(left, right int) bool {
		leftTime, _ := time.Parse(time.RFC3339Nano, checkpoints[left].CreatedAt)
		rightTime, _ := time.Parse(time.RFC3339Nano, checkpoints[right].CreatedAt)
		if leftTime.Equal(rightTime) {
			return checkpoints[left].CheckpointID > checkpoints[right].CheckpointID
		}
		return leftTime.After(rightTime)
	})
	return checkpoints, nil
}

// CaptureRecoveryCheckpoint freezes the active managed-slot membership for one scope.
func CaptureRecoveryCheckpoint(scope protocol.Scope, reason, excludeRestoreID string) (protocol.RecoveryCheckpoint, error) {
	if reason != "automatic" && reason != "manual" {
		return protocol.RecoveryCheckpoint{}, errors.New("recovery checkpoint reason must be automatic or manual")
	}
	if excludeRestoreID != "" && !validInstanceID(excludeRestoreID) {
		return protocol.RecoveryCheckpoint{}, errors.New("invalid restore ID to exclude from recovery checkpoint")
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return protocol.RecoveryCheckpoint{}, err
	}
	bootID, err := readBootID()
	if err != nil {
		return protocol.RecoveryCheckpoint{}, fmt.Errorf("read Linux boot identity for recovery checkpoint: %w", err)
	}
	if !validRecoveryBootID(bootID) {
		return protocol.RecoveryCheckpoint{}, errors.New("Linux boot identity has an unexpected format")
	}
	transport, err := NewTransport(scope)
	if err != nil {
		return protocol.RecoveryCheckpoint{}, err
	}
	records, err := transport.ReadRecords()
	if err != nil {
		return protocol.RecoveryCheckpoint{}, fmt.Errorf("read scoped managed-session records: %w", err)
	}
	entries := make([]protocol.RecoveryCheckpointEntry, 0, len(records))
	acceptedRestoreIDs := make(map[string]struct{}, len(records))
	for _, record := range records {
		restoreID := record.RestoreID
		if !record.LauncherManaged || !validInstanceID(restoreID) || restoreID == excludeRestoreID {
			continue
		}
		if _, accepted := acceptedRestoreIDs[restoreID]; accepted {
			continue
		}
		session, err := readSavedSession(directories, scope, restoreID, false)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return protocol.RecoveryCheckpoint{}, fmt.Errorf("read current restore snapshot for slot %s: %w", restoreID, err)
		}
		if session.SessionID != record.SessionID || session.CWD != record.CWD ||
			(record.SessionFile != nil && session.SessionFile != *record.SessionFile) {
			continue
		}
		if err := validateRecoveryPathIfPresent(session.CWD, true); err != nil {
			return protocol.RecoveryCheckpoint{}, fmt.Errorf("validate working directory for managed slot %s: %w", restoreID, err)
		}
		if err := validateRecoveryPathIfPresent(session.SessionFile, false); err != nil {
			return protocol.RecoveryCheckpoint{}, fmt.Errorf("validate session file for managed slot %s: %w", restoreID, err)
		}
		entries = append(entries, protocol.RecoveryCheckpointEntry{
			RestoreID: restoreID, SessionID: session.SessionID, CWD: session.CWD,
		})
		acceptedRestoreIDs[restoreID] = struct{}{}
	}
	checkpoint := protocol.RecoveryCheckpoint{
		Version: 1, CheckpointID: "", Scope: scope, BootID: bootID,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Reason: reason,
		Entries: entries,
	}
	for range 4 {
		checkpointID, err := randomRecoveryID()
		if err != nil {
			return protocol.RecoveryCheckpoint{}, err
		}
		checkpoint.CheckpointID = checkpointID
		if err := validateRecoveryCheckpoint(checkpoint, scope, checkpointID); err != nil {
			return protocol.RecoveryCheckpoint{}, err
		}
		err = publishImmutableRecoveryCheckpoint(directories, checkpoint)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return protocol.RecoveryCheckpoint{}, fmt.Errorf("publish recovery checkpoint: %w", err)
		}
		if err := pruneRecoveryCheckpoints(scope, bootID); err != nil {
			return protocol.RecoveryCheckpoint{}, fmt.Errorf("prune recovery checkpoints: %w", err)
		}
		return checkpoint, nil
	}
	return protocol.RecoveryCheckpoint{}, errors.New("could not allocate a unique recovery checkpoint ID")
}

// ListRecoverySessions returns default recovery candidates or one checkpoint's membership.
func ListRecoverySessions(scope protocol.Scope, checkpointID string) ([]protocol.RecoverySession, error) {
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return nil, err
	}
	checkpoints, err := ListRecoveryCheckpoints(scope)
	if err != nil {
		return nil, err
	}
	var selected *protocol.RecoveryCheckpoint
	if checkpointID != "" {
		if !validInstanceID(checkpointID) {
			return nil, errors.New("invalid recovery checkpoint ID")
		}
		for index := range checkpoints {
			if checkpoints[index].CheckpointID == checkpointID {
				selected = &checkpoints[index]
				break
			}
		}
		if selected == nil {
			return nil, fmt.Errorf("recovery checkpoint not found: %s", checkpointID)
		}
	} else {
		bootID, err := readBootID()
		if err != nil {
			return nil, fmt.Errorf("read Linux boot identity for recovery selection: %w", err)
		}
		selected = defaultRecoveryCheckpoint(checkpoints, bootID)
	}

	names, err := readRecoveryNameCandidates(directories, scope)
	if err != nil {
		return nil, err
	}
	aliases := make(map[string]string, len(names))
	for _, candidate := range names {
		if _, exists := aliases[candidate.restoreID]; !exists {
			aliases[candidate.restoreID] = candidate.name
		}
	}

	membership := []protocol.RecoveryCheckpointEntry(nil)
	if selected != nil {
		membership = selected.Entries
	} else {
		membership, err = discoverRecoverySnapshots(directories)
		if err != nil {
			return nil, err
		}
	}
	candidates := make([]protocol.RecoveryCheckpointEntry, 0, len(membership)+len(names))
	candidates = append(candidates, membership...)
	if checkpointID == "" {
		for _, candidate := range names {
			candidates = append(candidates, protocol.RecoveryCheckpointEntry{RestoreID: candidate.restoreID})
		}
	}

	sessions := make([]protocol.RecoverySession, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		if _, exists := seen[candidate.RestoreID]; exists {
			continue
		}
		seen[candidate.RestoreID] = struct{}{}
		session, unavailable, err := readRecoveryCandidate(directories, scope, candidate.RestoreID)
		if err != nil {
			return nil, fmt.Errorf("validate recovery slot %s: %w", candidate.RestoreID, err)
		}
		if unavailable != "" {
			sessions = append(sessions, protocol.RecoverySession{
				RestoreID: candidate.RestoreID, Name: aliases[candidate.RestoreID], Unavailable: unavailable,
			})
			continue
		}
		sessions = append(sessions, protocol.RecoverySession{
			RestoreID: candidate.RestoreID, Name: aliases[candidate.RestoreID], Session: &session,
		})
	}
	if selected != nil && selected.Reason == "legacy" {
		for index := range selected.Legacy {
			legacy := selected.Legacy[index]
			if legacy.Unavailable == "" {
				if err := validateRestorePath(legacy.CWD, true); errors.Is(err, os.ErrNotExist) {
					legacy.Unavailable = "Imported legacy working directory is unavailable."
				} else if err != nil {
					return nil, fmt.Errorf("validate imported legacy working directory: %w", err)
				}
				if legacy.Unavailable == "" {
					if err := validateRestorePath(legacy.SessionFile, false); errors.Is(err, os.ErrNotExist) {
						legacy.Unavailable = "Imported legacy transcript is unavailable."
					} else if err != nil {
						return nil, fmt.Errorf("validate imported legacy transcript: %w", err)
					}
				}
			}
			sessions = append(sessions, protocol.RecoverySession{Legacy: &legacy})
		}
	}
	return sessions, nil
}

func readRecoveryCandidate(directories restoreDirectories, scope protocol.Scope, restoreID string) (protocol.SavedSession, string, error) {
	session, err := readSavedSession(directories, scope, restoreID, false)
	if errors.Is(err, os.ErrNotExist) {
		return protocol.SavedSession{}, missingRecoverySnapshotReason, nil
	}
	if err != nil {
		return protocol.SavedSession{}, "", err
	}
	if err := validateRestorePath(session.CWD, true); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return protocol.SavedSession{}, missingRecoveryPathReason, nil
		}
		return protocol.SavedSession{}, "", fmt.Errorf("saved working directory is missing or unsafe: %w", err)
	}
	if err := validateRestorePath(session.SessionFile, false); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return protocol.SavedSession{}, missingRecoveryPathReason, nil
		}
		return protocol.SavedSession{}, "", fmt.Errorf("saved session file is missing or unsafe: %w", err)
	}
	return session, "", nil
}

// ExportRecoveryCommands produces review-only, safely quoted POSIX commands.
func ExportRecoveryCommands(scope protocol.Scope, sessions []protocol.RecoverySession) (string, error) {
	if err := validateRecoveryScope(scope); err != nil {
		return "", err
	}
	var output strings.Builder
	output.WriteString("# Recovery commands are for manual review; they are not executed.\n")
	for _, candidate := range sessions {
		if candidate.Legacy != nil {
			legacy := candidate.Legacy
			if err := validateRecoveryLegacyEntry(scope, *legacy); err != nil {
				return "", fmt.Errorf("cannot export unsafe legacy recovery entry: %w", err)
			}
			if legacy.Unavailable != "" || legacy.SessionFile == "" || validateExportPath(legacy.CWD) != nil || validateExportPath(legacy.SessionFile) != nil {
				output.WriteString("# Imported legacy session is unavailable or requires manual review; no command was generated.\n")
				continue
			}
			if !legacyTranscriptWithinScope(scope, legacy.SessionFile) {
				return "", errors.New("cannot export a legacy transcript outside the selected OMP scope")
			}
			if err := validateRecoveryPathIfPresent(legacy.CWD, true); err != nil {
				return "", fmt.Errorf("cannot export unsafe legacy working directory: %w", err)
			}
			if err := validateRecoveryPathIfPresent(legacy.SessionFile, false); err != nil {
				return "", fmt.Errorf("cannot export unsafe legacy transcript: %w", err)
			}
			output.WriteString("# Imported legacy session is unowned; review before running.\n")
			output.WriteString(recoveryExportCommand(scope, legacy.CWD, "-r "+shellQuote(legacy.SessionFile)))
			output.WriteByte('\n')
			continue
		}
		if candidate.Session == nil {
			output.WriteString("# Recovery slot is unavailable; no command was generated.\n")
			continue
		}
		session := candidate.Session
		if session.Version != 1 || session.Scope != scope || session.RestoreID != candidate.RestoreID || !validInstanceID(candidate.RestoreID) {
			return "", errors.New("cannot export a managed recovery session from another scope or slot")
		}
		if err := validateExportPath(session.CWD); err != nil {
			return "", fmt.Errorf("cannot export unsafe recovery working directory: %w", err)
		}
		if err := validateExportPath(session.SessionFile); err != nil {
			return "", fmt.Errorf("cannot export unsafe recovery session file: %w", err)
		}
		arguments := fmt.Sprintf("restore --slot %s --profile=%s", shellQuote(candidate.RestoreID), shellQuote(scope.Profile))
		output.WriteString("# Managed recovery slot; ownership and its current snapshot are rechecked by ompi.\n")
		output.WriteString(recoveryExportCommand(scope, session.CWD, arguments))
		output.WriteByte('\n')
	}
	return output.String(), nil
}

func recoveryExportCommand(scope protocol.Scope, cwd, arguments string) string {
	environment := []string{
		"-u PI_CODING_AGENT_DIR",
		"PI_CONFIG_DIR=" + shellQuote(scope.ConfigRoot),
		"OMP_PROFILE=" + shellQuote(scope.Profile),
	}
	if scope.Profile == "default" {
		environment = append(environment, "PI_CODING_AGENT_DIR="+shellQuote(scope.AgentDir))
	}
	return fmt.Sprintf("cd %s && env %s ompi %s",
		shellQuote(cwd), strings.Join(environment, " "), arguments)
}

func readRecoveryCheckpoint(directories restoreDirectories, scope protocol.Scope, checkpointID string) (protocol.RecoveryCheckpoint, error) {
	var checkpoint protocol.RecoveryCheckpoint
	file := filepath.Join(directories.checkpoints, checkpointID+".json")
	if err := readRestoreJSON(file, &checkpoint); err != nil {
		return protocol.RecoveryCheckpoint{}, err
	}
	if err := validateRecoveryCheckpoint(checkpoint, scope, checkpointID); err != nil {
		return protocol.RecoveryCheckpoint{}, err
	}
	return checkpoint, nil
}

func validateRecoveryCheckpoint(checkpoint protocol.RecoveryCheckpoint, scope protocol.Scope, checkpointID string) error {
	if checkpoint.Version != 1 || checkpoint.CheckpointID != checkpointID || !validInstanceID(checkpointID) || checkpoint.Scope != scope {
		return errors.New("checkpoint version, identity, or scope does not match")
	}
	if checkpoint.Reason != "automatic" && checkpoint.Reason != "manual" && checkpoint.Reason != "legacy" {
		return errors.New("checkpoint reason is invalid")
	}
	if _, err := time.Parse(time.RFC3339Nano, checkpoint.CreatedAt); err != nil {
		return fmt.Errorf("checkpoint creation time is invalid: %w", err)
	}
	if checkpoint.Entries == nil {
		return errors.New("checkpoint entries must be an array")
	}
	if checkpoint.Reason == "legacy" {
		if checkpoint.BootID != "legacy" || len(checkpoint.Entries) != 0 || checkpoint.SourcePath == "" ||
			!filepath.IsAbs(checkpoint.SourcePath) || filepath.Clean(checkpoint.SourcePath) != checkpoint.SourcePath ||
			!validRecoveryText(checkpoint.SourcePath, 4096) || !validRecoveryHash(checkpoint.SourceSha256) {
			return errors.New("legacy checkpoint provenance or boot identity is invalid")
		}
	} else if !validRecoveryBootID(checkpoint.BootID) || checkpoint.SourcePath != "" || checkpoint.SourceSha256 != "" || len(checkpoint.Legacy) != 0 {
		return errors.New("managed checkpoint boot identity or legacy metadata is invalid")
	}
	seen := make(map[string]struct{}, len(checkpoint.Entries))
	for _, entry := range checkpoint.Entries {
		if !validInstanceID(entry.RestoreID) {
			return errors.New("checkpoint contains an invalid restore ID")
		}
		if _, exists := seen[entry.RestoreID]; exists {
			return errors.New("checkpoint contains a duplicate restore ID")
		}
		seen[entry.RestoreID] = struct{}{}
		if err := validateRecoveryEntry(entry.SessionID, entry.CWD); err != nil {
			return fmt.Errorf("checkpoint entry %s is invalid: %w", entry.RestoreID, err)
		}
	}
	for _, legacy := range checkpoint.Legacy {
		if err := validateRecoveryLegacyEntry(scope, legacy); err != nil {
			return err
		}
	}
	if len(checkpoint.Warnings) != 0 && checkpoint.Reason != "legacy" {
		return errors.New("only legacy checkpoints may contain import warnings")
	}
	for _, warning := range checkpoint.Warnings {
		if !validLegacyImportWarning(warning) {
			return errors.New("checkpoint warning is invalid or contains unsupported source text")
		}
	}
	return nil
}

func validLegacyImportWarning(value string) bool {
	const suffix = ": unsupported legacy command format"
	if !strings.HasPrefix(value, "line ") || !strings.HasSuffix(value, suffix) {
		return false
	}
	lineNumber := strings.TrimSuffix(strings.TrimPrefix(value, "line "), suffix)
	parsed, err := strconv.Atoi(lineNumber)
	return err == nil && parsed > 0 && strconv.Itoa(parsed) == lineNumber
}
func validateRecoveryEntry(sessionID, cwd string) error {
	if !validRecoveryText(sessionID, 512) {
		return errors.New("session ID is empty, too long, or contains control characters")
	}
	if err := validateRecoveryAbsolutePath(cwd); err != nil {
		return fmt.Errorf("working directory is invalid: %w", err)
	}
	return nil
}

func validateRecoveryLegacyEntry(scope protocol.Scope, entry protocol.RecoveryLegacyEntry) error {
	if !validRecoveryText(entry.SessionID, 512) {
		return errors.New("legacy session ID is empty, too long, or contains control characters")
	}
	if entry.CWD != "" {
		if err := validateRecoveryAbsolutePath(entry.CWD); err != nil {
			return fmt.Errorf("legacy working directory is invalid: %w", err)
		}
		if err := rejectExistingSymlinkComponents(entry.CWD); err != nil {
			return fmt.Errorf("legacy working directory is unsafe: %w", err)
		}
		if err := validateRestorePath(entry.CWD, true); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("legacy working directory is unsafe: %w", err)
		}
	}
	if entry.SessionFile != "" {
		if err := validateRecoveryAbsolutePath(entry.SessionFile); err != nil {
			return fmt.Errorf("legacy session file is invalid: %w", err)
		}
		if !legacyTranscriptWithinScope(scope, entry.SessionFile) {
			return errors.New("legacy transcript path is outside the selected OMP scope")
		}
		if err := rejectExistingSymlinkComponents(entry.SessionFile); err != nil {
			return fmt.Errorf("legacy session file is unsafe: %w", err)
		}
		if err := validateRestorePath(entry.SessionFile, false); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("legacy session file is unsafe: %w", err)
			}
		} else {
			sessionID, valid, err := readLegacySessionID(entry.SessionFile)
			if errors.Is(err, os.ErrNotExist) {
				// The transcript disappeared after path validation; preserve its known path.
			} else if err != nil {
				return fmt.Errorf("read legacy session header: %w", err)
			} else if !valid || sessionID != entry.SessionID {
				return errors.New("legacy transcript no longer matches its imported session ID")
			}
		}
	}
	if entry.Unavailable != "" && !validRecoveryText(entry.Unavailable, 2048) {
		return errors.New("legacy unavailable reason is invalid")
	}
	if (entry.CWD == "" || entry.SessionFile == "") && entry.Unavailable == "" {
		return errors.New("legacy entry without a complete path must explain its unavailability")
	}
	return nil
}

func legacyTranscriptWithinScope(scope protocol.Scope, sessionFile string) bool {
	sessionsDirectory := filepath.Join(scope.AgentDir, "sessions")
	relative, err := filepath.Rel(sessionsDirectory, sessionFile)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false
	}
	return strings.HasSuffix(sessionFile, ".jsonl")
}

func validateRecoveryAbsolutePath(value string) error {
	if !validRecoveryText(value, 4096) || !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return errors.New("expected a normalized absolute path without control characters")
	}
	return nil
}

func rejectExistingSymlinkComponents(value string) error {
	root := filepath.VolumeName(value) + string(filepath.Separator)
	relative := strings.TrimPrefix(value, root)
	current := root
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" {
			continue
		}
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("path contains a symbolic link: %s", current)
		}
	}
	return nil
}

func validateRecoveryPathIfPresent(value string, directory bool) error {
	if err := validateRecoveryAbsolutePath(value); err != nil {
		return err
	}
	if err := rejectExistingSymlinkComponents(value); err != nil {
		return err
	}
	err := validateRestorePath(value, directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func validateExportPath(value string) error {
	return validateRecoveryAbsolutePath(value)
}

func validRecoveryText(value string, maximum int) bool {
	if value == "" || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func validRecoveryBootID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
			continue
		}
		if !strings.ContainsRune("0123456789abcdef", character) {
			return false
		}
	}
	return true
}

func validRecoveryHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return false
		}
	}
	return true
}

func validateRecoveryScope(scope protocol.Scope) error {
	if !validScopeID(scope.ID) || !restoreProfilePattern.MatchString(scope.Profile) ||
		validateRecoveryAbsolutePath(scope.ConfigRoot) != nil || validateRecoveryAbsolutePath(scope.AgentDir) != nil {
		return errors.New("invalid recovery scope")
	}
	return nil
}

func randomRecoveryID() (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", fmt.Errorf("generate recovery checkpoint ID: %w", err)
	}
	return hex.EncodeToString(random[:]), nil
}

func publishImmutableRecoveryCheckpoint(directories restoreDirectories, checkpoint protocol.RecoveryCheckpoint) error {
	encoded, err := json.Marshal(checkpoint)
	if err != nil {
		return err
	}
	if len(encoded)+1 > maxRecoveryCheckpointBytes {
		return errors.New("recovery checkpoint exceeds the size limit")
	}
	encoded = append(encoded, '\n')
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return fmt.Errorf("generate private checkpoint temporary name: %w", err)
	}
	temporary := filepath.Join(directories.checkpoints, ".checkpoint-"+hex.EncodeToString(random[:])+".tmp")
	handle, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if err := writeAll(handle, encoded); err != nil {
		_ = handle.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := handle.Sync(); err != nil {
		_ = handle.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := handle.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	defer os.Remove(temporary)
	finalPath := filepath.Join(directories.checkpoints, checkpoint.CheckpointID+".json")
	if err := os.Link(temporary, finalPath); err != nil {
		return err
	}
	return nil
}

func pruneRecoveryCheckpoints(scope protocol.Scope, currentBootID string) error {
	checkpoints, err := ListRecoveryCheckpoints(scope)
	if err != nil {
		return err
	}
	retained := make(map[string]struct{}, 11)
	for index, checkpoint := range checkpoints {
		if index == 10 {
			break
		}
		retained[checkpoint.CheckpointID] = struct{}{}
	}
	for _, checkpoint := range checkpoints {
		if checkpoint.Reason != "legacy" && checkpoint.BootID != currentBootID {
			retained[checkpoint.CheckpointID] = struct{}{}
			break
		}
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return err
	}
	for _, checkpoint := range checkpoints {
		if _, keep := retained[checkpoint.CheckpointID]; keep {
			continue
		}
		if _, err := readRecoveryCheckpoint(directories, scope, checkpoint.CheckpointID); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return err
		}
		file := filepath.Join(directories.checkpoints, checkpoint.CheckpointID+".json")
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func defaultRecoveryCheckpoint(checkpoints []protocol.RecoveryCheckpoint, currentBootID string) *protocol.RecoveryCheckpoint {
	for index := range checkpoints {
		if checkpoints[index].Reason != "legacy" && checkpoints[index].BootID != currentBootID {
			return &checkpoints[index]
		}
	}
	for index := range checkpoints {
		if checkpoints[index].Reason != "legacy" && checkpoints[index].BootID == currentBootID {
			return &checkpoints[index]
		}
	}
	return nil
}

func readRecoveryNameCandidates(directories restoreDirectories, scope protocol.Scope) ([]recoveryNameCandidate, error) {
	entries, err := os.ReadDir(directories.names)
	if err != nil {
		return nil, fmt.Errorf("read saved restore names: %w", err)
	}
	candidates := make([]recoveryNameCandidate, 0, len(entries))
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".json")
		if err := protocol.ValidateRestoreName(name); err != nil {
			return nil, fmt.Errorf("unsafe saved restore name file %q: %w", entry.Name(), err)
		}
		binding, err := readRestoreName(directories, name)
		if err != nil {
			return nil, fmt.Errorf("read saved restore name %q: %w", name, err)
		}
		if _, err := readSavedSession(directories, scope, binding.RestoreID, false); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("saved restore name %q refers to an invalid snapshot: %w", name, err)
		}
		candidates = append(candidates, recoveryNameCandidate{name: name, restoreID: binding.RestoreID})
	}
	sort.Slice(candidates, func(left, right int) bool { return candidates[left].name < candidates[right].name })
	return candidates, nil
}

type recoveryNameCandidate struct {
	name      string
	restoreID string
}

func discoverRecoverySnapshots(directories restoreDirectories) ([]protocol.RecoveryCheckpointEntry, error) {
	files, err := os.ReadDir(directories.snapshots)
	if err != nil {
		return nil, fmt.Errorf("read managed restore snapshots: %w", err)
	}
	candidates := make([]protocol.RecoveryCheckpointEntry, 0, len(files))
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		restoreID := strings.TrimSuffix(file.Name(), ".json")
		if !validInstanceID(restoreID) {
			return nil, fmt.Errorf("invalid managed restore snapshot filename %q", file.Name())
		}
		candidates = append(candidates, protocol.RecoveryCheckpointEntry{RestoreID: restoreID})
	}
	return candidates, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
