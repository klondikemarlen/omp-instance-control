package linux

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const maxLegacyRecoverySourceBytes = 1 << 20
const maxLegacySessionHeaderBytes = 64 << 10

// ImportLegacyRecovery imports helper history as review-only checkpoints.
// Imported records never receive managed restore IDs or process owners.
func ImportLegacyRecovery(scope protocol.Scope, source string) ([]protocol.RecoveryCheckpoint, error) {
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		return nil, err
	}
	var sources []string
	if source == "" {
		sources, err = defaultLegacyRecoverySources()
		if err != nil {
			return nil, err
		}
	} else {
		absolute, err := filepath.Abs(source)
		if err != nil {
			return nil, fmt.Errorf("resolve legacy recovery source: %w", err)
		}
		sources = []string{absolute}
	}
	index, indexLoaded := map[string][]string(nil), false
	checkpoints := make([]protocol.RecoveryCheckpoint, 0, len(sources))
	for _, file := range sources {
		contents, absolute, err := readLegacyRecoverySource(file)
		if err != nil {
			if source == "" && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		commands, warnings := parseLegacyRecoveryCommands(contents)
		if len(commands) > 0 && !indexLoaded {
			index, err = indexLegacySessionTree(scope)
			if err != nil {
				return nil, err
			}
			indexLoaded = true
		}
		legacy := make([]protocol.RecoveryLegacyEntry, 0, len(commands))
		for _, command := range commands {
			entry := protocol.RecoveryLegacyEntry{SessionID: command.sessionID}
			if err := validateRecoveryAbsolutePath(command.cwd); err != nil {
				entry.Unavailable = "Legacy command working directory is not a normalized absolute path."
			} else {
				entry.CWD = command.cwd
				switch len(index[command.sessionID]) {
				case 0:
					entry.Unavailable = "No transcript with this session ID exists in the selected OMP scope."
				case 1:
					entry.SessionFile = index[command.sessionID][0]
				default:
					entry.Unavailable = "More than one transcript with this session ID exists in the selected OMP scope."
				}
			}
			if entry.CWD != "" {
				if err := rejectExistingSymlinkComponents(entry.CWD); err != nil {
					return nil, fmt.Errorf("validate legacy working directory: %w", err)
				}
				if err := validateRestorePath(entry.CWD, true); errors.Is(err, os.ErrNotExist) {
					appendLegacyUnavailable(&entry, "Legacy working directory is unavailable.")
				} else if err != nil {
					return nil, fmt.Errorf("validate legacy working directory: %w", err)
				}
			}
			if entry.SessionFile != "" {
				if err := rejectExistingSymlinkComponents(entry.SessionFile); err != nil {
					return nil, fmt.Errorf("validate legacy transcript: %w", err)
				}
				if err := validateRestorePath(entry.SessionFile, false); errors.Is(err, os.ErrNotExist) {
					appendLegacyUnavailable(&entry, "Imported transcript is unavailable.")
				} else if err != nil {
					return nil, fmt.Errorf("validate legacy transcript: %w", err)
				}
			}
			legacy = append(legacy, entry)
		}
		contentHash := sha256.Sum256(contents)
		identity := sha256.New()
		_, _ = identity.Write([]byte(absolute))
		_, _ = identity.Write([]byte{0})
		_, _ = identity.Write(contents)
		checkpointID := hex.EncodeToString(identity.Sum(nil)[:16])
		checkpoint := protocol.RecoveryCheckpoint{
			Version: 1, CheckpointID: checkpointID, Scope: scope, BootID: "legacy",
			CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Reason: "legacy",
			Entries: []protocol.RecoveryCheckpointEntry{}, Legacy: legacy,
			SourcePath: absolute, SourceSha256: hex.EncodeToString(contentHash[:]), Warnings: warnings,
		}
		if existing, err := readRecoveryCheckpoint(directories, scope, checkpointID); err == nil {
			if existing.SourcePath != absolute || existing.SourceSha256 != checkpoint.SourceSha256 {
				return nil, errors.New("legacy recovery source identity collided with a different imported checkpoint")
			}
			checkpoints = append(checkpoints, existing)
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("read existing imported recovery checkpoint: %w", err)
		}
		if err := validateRecoveryCheckpoint(checkpoint, scope, checkpointID); err != nil {
			return nil, err
		}
		if err := publishImmutableRecoveryCheckpoint(directories, checkpoint); err != nil {
			if !errors.Is(err, os.ErrExist) {
				return nil, fmt.Errorf("publish imported recovery checkpoint: %w", err)
			}
			existing, readErr := readRecoveryCheckpoint(directories, scope, checkpointID)
			if readErr != nil || existing.SourcePath != absolute || existing.SourceSha256 != checkpoint.SourceSha256 {
				if readErr != nil {
					return nil, fmt.Errorf("read concurrently imported recovery checkpoint: %w", readErr)
				}
				return nil, errors.New("legacy recovery source identity collided with a different imported checkpoint")
			}
			checkpoint = existing
		}
		checkpoints = append(checkpoints, checkpoint)
	}

	bootID, err := readBootID()
	if err != nil {
		return nil, fmt.Errorf("read Linux boot identity while pruning imported checkpoints: %w", err)
	}
	if err := pruneRecoveryCheckpoints(scope, bootID); err != nil {
		return nil, fmt.Errorf("prune imported recovery checkpoints: %w", err)
	}
	retained, err := ListRecoveryCheckpoints(scope)
	if err != nil {
		return nil, fmt.Errorf("read retained imported recovery checkpoints: %w", err)
	}
	retainedIDs := make(map[string]struct{}, len(retained))
	for _, checkpoint := range retained {
		retainedIDs[checkpoint.CheckpointID] = struct{}{}
	}
	imported := checkpoints[:0]
	for _, checkpoint := range checkpoints {
		if _, keep := retainedIDs[checkpoint.CheckpointID]; keep {
			imported = append(imported, checkpoint)
		}
	}
	return imported, nil
}

func appendLegacyUnavailable(entry *protocol.RecoveryLegacyEntry, reason string) {
	if entry.Unavailable != "" {
		entry.Unavailable += "; "
	}
	entry.Unavailable += reason
}

type legacyRecoveryCommand struct {
	cwd       string
	sessionID string
}

func defaultLegacyRecoverySources() ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("resolve home for legacy recovery history: %w", err)
	}
	home, err = filepath.Abs(home)
	if err != nil {
		return nil, fmt.Errorf("resolve absolute home for legacy recovery history: %w", err)
	}
	helperDirectory := filepath.Join(home, ".local", "state", "omp-session-resume-helper")
	if err := validateLegacyDirectoryIfPresent(helperDirectory); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(helperDirectory); errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	} else if err != nil {
		return nil, err
	}

	sources := make([]string, 0)
	snapshotDirectory := filepath.Join(helperDirectory, "snapshots")
	if err := validateLegacyDirectoryIfPresent(snapshotDirectory); err != nil {
		return nil, err
	}
	if entries, err := os.ReadDir(snapshotDirectory); err == nil {
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".txt") {
				sources = append(sources, filepath.Join(snapshotDirectory, entry.Name()))
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read legacy recovery snapshots: %w", err)
	}
	activeSessions := filepath.Join(helperDirectory, "active-sessions.txt")
	if _, err := os.Lstat(activeSessions); err == nil {
		sources = append(sources, activeSessions)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	sort.Strings(sources)
	return sources, nil
}

func validateLegacyDirectoryIfPresent(directory string) error {
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("unsafe legacy recovery directory %q", directory)
	}
	uid, err := fileOwnerUID(info)
	if err != nil {
		return err
	}
	if uid != uint32(os.Getuid()) {
		return fmt.Errorf("legacy recovery directory %q is not owned by the current user", directory)
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return err
	}
	if resolved != directory {
		return fmt.Errorf("legacy recovery directory %q traverses a symbolic link", directory)
	}
	return nil
}

func readLegacyRecoverySource(file string) ([]byte, string, error) {
	absolute, err := filepath.Abs(file)
	if err != nil {
		return nil, "", fmt.Errorf("resolve legacy recovery source: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, "", fmt.Errorf("resolve legacy recovery source %q: %w", absolute, err)
	}
	if resolved != absolute {
		return nil, "", fmt.Errorf("legacy recovery source %q traverses a symbolic link", absolute)
	}
	handle, err := os.OpenFile(absolute, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, "", fmt.Errorf("open legacy recovery source %q: %w", absolute, err)
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return nil, "", err
	}
	uid, err := fileOwnerUID(info)
	if err != nil {
		return nil, "", err
	}
	if !info.Mode().IsRegular() || uid != uint32(os.Getuid()) {
		return nil, "", fmt.Errorf("legacy recovery source %q is not a regular file owned by the current user", absolute)
	}
	if info.Size() > maxLegacyRecoverySourceBytes {
		return nil, "", fmt.Errorf("legacy recovery source %q exceeds the size limit", absolute)
	}
	contents, err := io.ReadAll(io.LimitReader(handle, maxLegacyRecoverySourceBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("read legacy recovery source %q: %w", absolute, err)
	}
	if len(contents) > maxLegacyRecoverySourceBytes {
		return nil, "", fmt.Errorf("legacy recovery source %q exceeds the size limit", absolute)
	}
	return contents, absolute, nil
}

func parseLegacyRecoveryCommands(contents []byte) ([]legacyRecoveryCommand, []string) {
	lines := strings.Split(string(contents), "\n")
	commands := make([]legacyRecoveryCommand, 0, len(lines))
	warnings := make([]string, 0)
	for index, line := range lines {
		if line == "" {
			continue
		}
		if strings.HasSuffix(line, "\r") {
			line = strings.TrimSuffix(line, "\r")
		}
		cwd, sessionID, ok := parseLegacyRecoveryCommand(line)
		if !ok || !validRecoveryText(sessionID, 512) {
			warnings = append(warnings, fmt.Sprintf("line %d: unsupported legacy command format", index+1))
			continue
		}
		commands = append(commands, legacyRecoveryCommand{cwd: cwd, sessionID: sessionID})
	}
	return commands, warnings
}

func parseLegacyRecoveryCommand(line string) (string, string, bool) {
	const prefix = "cd "
	const separator = " && omp --resume "
	if !strings.HasPrefix(line, prefix) {
		return "", "", false
	}
	cwd, offset, ok := parseLegacySingleQuoted(line, len(prefix))
	if !ok || !strings.HasPrefix(line[offset:], separator) {
		return "", "", false
	}
	sessionID, offset, ok := parseLegacySingleQuoted(line, offset+len(separator))
	if !ok || offset != len(line) {
		return "", "", false
	}
	return cwd, sessionID, true
}

func parseLegacySingleQuoted(value string, offset int) (string, int, bool) {
	if offset >= len(value) || value[offset] != '\'' {
		return "", offset, false
	}
	offset++
	var parsed strings.Builder
	for offset < len(value) {
		if value[offset] != '\'' {
			parsed.WriteByte(value[offset])
			offset++
			continue
		}
		if strings.HasPrefix(value[offset:], "'\\''") {
			parsed.WriteByte('\'')
			offset += len("'\\''")
			continue
		}
		return parsed.String(), offset + 1, true
	}
	return "", offset, false
}

func indexLegacySessionTree(scope protocol.Scope) (map[string][]string, error) {
	index := make(map[string][]string)
	directory := filepath.Join(scope.AgentDir, "sessions")
	if err := validateLegacyDirectoryIfPresent(directory); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(directory); errors.Is(err, os.ErrNotExist) {
		return index, nil
	} else if err != nil {
		return nil, err
	}
	err := filepath.WalkDir(directory, func(file string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("legacy session tree contains a symbolic link: %s", file)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		uid, err := fileOwnerUID(info)
		if err != nil {
			return err
		}
		if uid != uint32(os.Getuid()) {
			return fmt.Errorf("legacy session tree path is not owned by the current user: %s", file)
		}
		if entry.IsDir() {
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".jsonl") {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("legacy session transcript is not a regular file: %s", file)
		}
		sessionID, valid, err := readLegacySessionID(file)
		if err != nil {
			return err
		}
		if valid {
			absolute, err := filepath.Abs(file)
			if err != nil {
				return err
			}
			index[sessionID] = append(index[sessionID], absolute)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("scan scoped OMP session transcripts: %w", err)
	}
	for sessionID := range index {
		sort.Strings(index[sessionID])
	}
	return index, nil
}

func readLegacySessionID(file string) (string, bool, error) {
	handle, err := os.OpenFile(file, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return "", false, fmt.Errorf("open scoped OMP transcript %q: %w", file, err)
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return "", false, err
	}
	uid, err := fileOwnerUID(info)
	if err != nil {
		return "", false, err
	}
	if !info.Mode().IsRegular() || uid != uint32(os.Getuid()) {
		return "", false, fmt.Errorf("scoped OMP transcript is unsafe: %s", file)
	}
	reader := bufio.NewReader(io.LimitReader(handle, maxLegacySessionHeaderBytes+1))
	line, err := reader.ReadString('\n')
	if len(line) > maxLegacySessionHeaderBytes {
		return "", false, nil
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return "", false, err
	}
	var header struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &header); err != nil || header.Type != "session" || !validRecoveryText(header.ID, 512) {
		return "", false, nil
	}
	return header.ID, true, nil
}
