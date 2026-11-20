package linux

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const maxWorkClaimBytes = 64 * 1024

var workClaimFilename = regexp.MustCompile(`^[a-f0-9]{64}\.json$`)
var workTemporaryFilename = regexp.MustCompile(`^[a-f0-9]{64}\.json\.[0-9]+\.[a-f0-9]{32}\.tmp$`)
var workTimestamp = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)

// ReadWorkClaims reads only the private claim records in the selected scope.
func ReadWorkClaims(scope protocol.Scope) ([]protocol.WorkClaim, error) {
	directory, err := workClaimsDirectory(scope)
	if err != nil {
		return nil, err
	}
	if err := checkWorkClaimsDirectory(directory); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []protocol.WorkClaim{}, nil
		}
		return nil, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}

	claims := make([]protocol.WorkClaim, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		file := filepath.Join(directory, name)
		switch {
		case workClaimFilename.MatchString(name):
			claim, err := readWorkClaim(scope, file)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, fmt.Errorf("read work claim %q: %w", name, err)
			}
			claims = append(claims, claim)
		case workTemporaryFilename.MatchString(name):
			// WritePrivateJSON may be in the middle of publishing a claim.
			info, err := os.Lstat(file)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if !isPrivateWorkClaimFile(info) {
				return nil, fmt.Errorf("unsafe work claim temporary file: %q", name)
			}
		default:
			return nil, fmt.Errorf("unexpected entry in work claim directory: %q", name)
		}
	}
	return claims, nil
}

// WriteWorkClaim replaces only this conversation's claim in the selected scope.
func WriteWorkClaim(scope protocol.Scope, claim protocol.WorkClaim) error {
	if err := validateWorkClaim(scope, claim); err != nil {
		return err
	}
	directory, err := workClaimsDirectory(scope)
	if err != nil {
		return err
	}
	for _, privateDirectory := range []string{filepath.Dir(directory), directory} {
		if err := EnsurePrivateDirectory(privateDirectory); err != nil {
			return fmt.Errorf("prepare private work claim directory: %w", err)
		}
	}
	file := filepath.Join(directory, workClaimName(claim.SessionID, claim.SessionFile))
	if _, err := readWorkClaim(scope, file); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("refusing to replace unsafe work claim: %w", err)
	}
	return WritePrivateJSON(file, claim)
}

// ClearWorkClaim removes only the identified saved conversation's claim.
func ClearWorkClaim(scope protocol.Scope, sessionID, sessionFile string) error {
	if err := validateWorkSession(sessionID, sessionFile); err != nil {
		return err
	}
	directory, err := workClaimsDirectory(scope)
	if err != nil {
		return err
	}
	if err := checkWorkClaimsDirectory(directory); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	file := filepath.Join(directory, workClaimName(sessionID, sessionFile))
	if _, err := readWorkClaim(scope, file); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("refusing to remove unsafe work claim: %w", err)
	}
	err = os.Remove(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func workClaimsDirectory(scope protocol.Scope) (string, error) {
	if !validScopeID(scope.ID) || !filepath.IsAbs(scope.AgentDir) || filepath.Clean(scope.AgentDir) != scope.AgentDir {
		return "", errors.New("invalid work claim scope")
	}
	return filepath.Join(scope.AgentDir, "instance-control", "work", scope.ID), nil
}

// Lookups check the same ownership boundary as writes without creating directories.
func checkWorkClaimsDirectory(directory string) error {
	claimRoot := filepath.Dir(directory)
	current := "/"
	for _, component := range strings.Split(strings.TrimPrefix(directory, "/"), "/") {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return fmt.Errorf("unsafe work claim directory: %q is not a real directory", current)
		}
		uid, err := fileOwnerUID(info)
		if err != nil {
			return err
		}
		if current == claimRoot || current == directory {
			if uid != uint32(os.Getuid()) || info.Mode().Perm()&0o077 != 0 {
				return fmt.Errorf("work claim directory %q is not private to the current user", current)
			}
			continue
		}
		trustedOwner := uid == 0 || uid == uint32(os.Getuid())
		stickyTmp := current == "/tmp" && uid == 0 && info.Mode()&os.ModeSticky != 0
		if !trustedOwner || (info.Mode().Perm()&0o022 != 0 && !stickyTmp) {
			return fmt.Errorf("unsafe work claim directory ancestor: %q", current)
		}
	}
	return nil
}

func workClaimName(sessionID, sessionFile string) string {
	digest := sha256.Sum256([]byte(sessionID + "\x00" + sessionFile))
	return hex.EncodeToString(digest[:]) + ".json"
}

func readWorkClaim(scope protocol.Scope, file string) (protocol.WorkClaim, error) {
	var claim protocol.WorkClaim
	handle, err := os.OpenFile(file, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return claim, err
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return claim, err
	}
	if !isPrivateWorkClaimFile(info) {
		return claim, errors.New("work claim is not a regular file private to the current user")
	}
	if info.Size() > maxWorkClaimBytes {
		return claim, errors.New("work claim exceeds the size limit")
	}

	encoded, err := io.ReadAll(io.LimitReader(handle, maxWorkClaimBytes+1))
	if err != nil {
		return claim, err
	}
	if len(encoded) > maxWorkClaimBytes {
		return claim, errors.New("work claim exceeds the size limit")
	}
	if !utf8.Valid(encoded) || !json.Valid(encoded) {
		return claim, errors.New("invalid work claim JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claim); err != nil {
		return claim, err
	}
	if err := validateWorkClaim(scope, claim); err != nil {
		return claim, err
	}
	if filepath.Base(file) != workClaimName(claim.SessionID, claim.SessionFile) {
		return claim, errors.New("work claim filename does not match its conversation")
	}
	return claim, nil
}

func isPrivateWorkClaimFile(info os.FileInfo) bool {
	stat, isLinuxFile := info.Sys().(*syscall.Stat_t)
	return info.Mode().IsRegular() && isLinuxFile && stat.Uid == uint32(os.Getuid()) &&
		stat.Nlink <= 1 && info.Mode().Perm()&0o077 == 0
}

func validateWorkClaim(scope protocol.Scope, claim protocol.WorkClaim) error {
	if claim.Version != protocol.WorkClaimVersion || claim.Scope != scope.ID {
		return errors.New("work claim version or scope does not match")
	}
	if err := validateWorkSession(claim.SessionID, claim.SessionFile); err != nil {
		return err
	}
	if !filepath.IsAbs(claim.CWD) || !validWorkText(claim.CWD, 4096) {
		return errors.New("work claim working directory must be an absolute path of at most 4096 bytes without control characters")
	}
	canonicalURL, err := protocol.NormalizeWorkURL(claim.URL)
	if err != nil {
		return err
	}
	if claim.URL != canonicalURL {
		return errors.New("work claim URL must be canonical")
	}
	if !validWorkText(claim.Summary, 4096) {
		return errors.New("work claim summary must be nonempty and at most 4096 bytes without control characters")
	}
	if claim.Branch != "" && !validWorkText(claim.Branch, 256) {
		return errors.New("work claim branch must be nonempty and at most 256 bytes without control characters when supplied")
	}
	if !workTimestamp.MatchString(claim.UpdatedAt) {
		return errors.New("work claim updatedAt must be an RFC3339Nano timestamp in UTC")
	}
	if _, err := time.Parse(time.RFC3339Nano, claim.UpdatedAt); err != nil {
		return errors.New("work claim updatedAt is not a valid timestamp")
	}
	return nil
}

func validateWorkSession(sessionID, sessionFile string) error {
	if !validWorkText(sessionID, 512) {
		return errors.New("work claim requires a nonempty session ID of at most 512 bytes without control characters")
	}
	if !filepath.IsAbs(sessionFile) || !validWorkText(sessionFile, 4096) {
		return errors.New("work claim session file must be an absolute path of at most 4096 bytes without control characters")
	}
	return nil
}

func validWorkText(value string, maxBytes int) bool {
	return len(value) <= maxBytes && strings.TrimSpace(value) != "" && utf8.ValidString(value) && strings.IndexFunc(value, unicode.IsControl) < 0
}
