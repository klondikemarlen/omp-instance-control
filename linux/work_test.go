package linux

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestWorkClaimPersistenceIsPrivateAndScopedToSavedConversation(t *testing.T) {
	scope, claim := workClaimFixture(t)
	// A claim must not open the transcript, which need not be present to persist host metadata.
	writeWorkClaimFixture(t, scope, claim)
	assertWorkClaims(t, scope, claim)

	directory := filepath.Join(scope.AgentDir, "instance-control", "work", scope.ID)
	digest := sha256.Sum256([]byte(claim.SessionID + "\x00" + claim.SessionFile))
	file := filepath.Join(directory, fmt.Sprintf("%x.json", digest))
	assertWorkFileMode(t, filepath.Dir(directory), 0o700)
	assertWorkFileMode(t, directory, 0o700)
	assertWorkFileMode(t, file, 0o600)

	updated := claim
	updated.Summary = "Updated assertion"
	updated.UpdatedAt = "2026-11-20T13:00:00Z"
	writeWorkClaimFixture(t, scope, updated)
	assertWorkClaims(t, scope, updated)

	otherFile := claim
	otherFile.SessionFile += ".other"
	writeWorkClaimFixture(t, scope, otherFile)
	otherID := claim
	otherID.SessionID += "-other"
	writeWorkClaimFixture(t, scope, otherID)

	// Even scopes that share the same agent directory remain isolated by scope ID.
	otherScope := scope
	otherScope.ID = "bbbbbbbbbbbbbbbb"
	otherScope.Profile = "another"
	assertWorkClaims(t, otherScope)
	otherClaim := claim
	otherClaim.Scope = otherScope.ID
	writeWorkClaimFixture(t, otherScope, otherClaim)

	if err := ClearWorkClaim(scope, claim.SessionID, claim.SessionFile); err != nil {
		t.Fatal(err)
	}
	if err := ClearWorkClaim(scope, claim.SessionID, claim.SessionFile); err != nil {
		t.Fatalf("clearing an absent claim should be safe: %v", err)
	}
	assertWorkClaims(t, scope, otherFile, otherID)
	assertWorkClaims(t, otherScope, otherClaim)
}

func TestWorkClaimRejectsInvalidMetadata(t *testing.T) {
	scope, claim := workClaimFixture(t)
	for _, test := range []struct {
		name   string
		mutate func(*protocol.WorkClaim)
	}{
		{
			name:   "wrong version",
			mutate: func(claim *protocol.WorkClaim) { claim.Version++ },
		},
		{
			name:   "wrong scope",
			mutate: func(claim *protocol.WorkClaim) { claim.Scope = "bbbbbbbbbbbbbbbb" },
		},
		{
			name:   "empty saved identity",
			mutate: func(claim *protocol.WorkClaim) { claim.SessionID = "" },
		},
		{
			name:   "NUL in identity",
			mutate: func(claim *protocol.WorkClaim) { claim.SessionID = "other\x00session" },
		},
		{
			name:   "relative session file",
			mutate: func(claim *protocol.WorkClaim) { claim.SessionFile = "relative.jsonl" },
		},
		{
			name:   "relative worktree",
			mutate: func(claim *protocol.WorkClaim) { claim.CWD = "relative" },
		},
		{
			name:   "noncanonical URL",
			mutate: func(claim *protocol.WorkClaim) { claim.URL = "https://github.com/Owner/repo/issues/93" },
		},
		{
			name:   "blank summary",
			mutate: func(claim *protocol.WorkClaim) { claim.Summary = "  " },
		},
		{
			name:   "control character",
			mutate: func(claim *protocol.WorkClaim) { claim.Summary = "line\nsecond line" },
		},
		{
			name:   "oversized summary",
			mutate: func(claim *protocol.WorkClaim) { claim.Summary = strings.Repeat("x", 4097) },
		},
		{
			name:   "invalid UTF-8",
			mutate: func(claim *protocol.WorkClaim) { claim.Summary = "bad\xfftext" },
		},
		{
			name:   "oversized branch",
			mutate: func(claim *protocol.WorkClaim) { claim.Branch = strings.Repeat("x", 257) },
		},
		{
			name:   "non-UTC timestamp",
			mutate: func(claim *protocol.WorkClaim) { claim.UpdatedAt = "2026-11-20T12:00:00-07:00" },
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			invalid := claim
			test.mutate(&invalid)
			if err := WriteWorkClaim(scope, invalid); err == nil {
				t.Fatal("invalid claim was accepted")
			}
		})
	}
	assertWorkClaims(t, scope)
}

func TestWorkClaimsFailClosedOnUnsafeRecords(t *testing.T) {
	for _, test := range []struct {
		name    string
		prepare func(*testing.T, string, protocol.WorkClaim)
	}{
		{
			name: "symlink",
			prepare: func(t *testing.T, file string, _ protocol.WorkClaim) {
				target := filepath.Join(t.TempDir(), "target.json")
				writeWorkFixtureFile(t, target, []byte("sentinel"), 0o600)
				if err := os.Symlink(target, file); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "hard link",
			prepare: func(t *testing.T, file string, claim protocol.WorkClaim) {
				target := filepath.Join(t.TempDir(), "target.json")
				if err := WritePrivateJSON(target, claim); err != nil {
					t.Fatal(err)
				}
				if err := os.Link(target, file); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "FIFO",
			prepare: func(t *testing.T, file string, _ protocol.WorkClaim) {
				if err := syscall.Mkfifo(file, 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "other users can read",
			prepare: func(t *testing.T, file string, claim protocol.WorkClaim) {
				if err := WritePrivateJSON(file, claim); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(file, 0o644); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "oversized",
			prepare: func(t *testing.T, file string, _ protocol.WorkClaim) {
				writeWorkFixtureFile(t, file, make([]byte, maxWorkClaimBytes+1), 0o600)
			},
		},
		{
			name: "wrong scope",
			prepare: func(t *testing.T, file string, claim protocol.WorkClaim) {
				claim.Scope = "bbbbbbbbbbbbbbbb"
				if err := WritePrivateJSON(file, claim); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "wrong file key",
			prepare: func(t *testing.T, file string, claim protocol.WorkClaim) {
				claim.SessionFile += ".other"
				if err := WritePrivateJSON(file, claim); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "trailing JSON",
			prepare: func(t *testing.T, file string, _ protocol.WorkClaim) {
				writeWorkFixtureFile(t, file, []byte("{}{}"), 0o600)
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			scope, claim := workClaimFixture(t)
			directory, err := workClaimsDirectory(scope)
			if err != nil {
				t.Fatal(err)
			}
			if err := EnsurePrivateDirectory(directory); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(directory, workClaimName(claim.SessionID, claim.SessionFile))
			test.prepare(t, file, claim)
			if rows, err := ReadWorkClaims(scope); err == nil || rows != nil {
				t.Fatalf("ReadWorkClaims = %#v, %v; want no results and an error", rows, err)
			}
			if err := WriteWorkClaim(scope, claim); err == nil {
				t.Fatal("unsafe entry was replaced")
			}
			if err := ClearWorkClaim(scope, claim.SessionID, claim.SessionFile); err == nil {
				t.Fatal("unsafe entry was removed")
			}
			if _, err := os.Lstat(file); err != nil {
				t.Fatalf("unsafe entry was not preserved: %v", err)
			}
		})
	}
}

func TestReadWorkClaimsDistinguishesAtomicTempFilesFromUnexpectedEntries(t *testing.T) {
	scope, claim := workClaimFixture(t)
	writeWorkClaimFixture(t, scope, claim)
	directory, err := workClaimsDirectory(scope)
	if err != nil {
		t.Fatal(err)
	}
	temporaryName := workClaimName(claim.SessionID, claim.SessionFile) + ".123." + strings.Repeat("a", 32) + ".tmp"
	temporaryFile := filepath.Join(directory, temporaryName)
	writeWorkFixtureFile(t, temporaryFile, []byte("incomplete atomic publication"), 0o600)
	assertWorkClaims(t, scope, claim)
	writeWorkFixtureFile(t, filepath.Join(directory, "unexpected"), nil, 0o600)
	if _, err := ReadWorkClaims(scope); err == nil {
		t.Fatal("unknown entry did not fail closed")
	}
}

func TestAbsentWorkClaimsDoNotCreateState(t *testing.T) {
	scope, claim := workClaimFixture(t)
	assertWorkClaims(t, scope)
	if err := ClearWorkClaim(scope, claim.SessionID, claim.SessionFile); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(scope.ConfigRoot); !os.IsNotExist(err) {
		t.Fatalf("lookups created the config root or could not verify absence: %v", err)
	}
}

func TestWorkClaimsRejectAnUnsafeScopeDirectory(t *testing.T) {
	scope, claim := workClaimFixture(t)
	directory, err := workClaimsDirectory(scope)
	if err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDirectory(directory); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(directory); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), directory); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadWorkClaims(scope); err == nil {
		t.Error("read followed an unsafe scope directory")
	}
	if err := WriteWorkClaim(scope, claim); err == nil {
		t.Error("write followed an unsafe scope directory")
	}
	if err := ClearWorkClaim(scope, claim.SessionID, claim.SessionFile); err == nil {
		t.Error("clear followed an unsafe scope directory")
	}
}

func workClaimFixture(t *testing.T) (protocol.Scope, protocol.WorkClaim) {
	t.Helper()
	home := t.TempDir()
	scope := protocol.Scope{
		ID:         "aaaaaaaaaaaaaaaa",
		ConfigRoot: filepath.Join(home, ".omp"),
		Profile:    "default",
		AgentDir:   filepath.Join(home, ".omp", "agent"),
	}
	claim := protocol.WorkClaim{
		Version:     protocol.WorkClaimVersion,
		Scope:       scope.ID,
		SessionID:   "saved-session",
		SessionFile: filepath.Join(scope.AgentDir, "sessions", "conversation.jsonl"),
		CWD:         filepath.Join(home, "work tree"),
		URL:         "https://github.com/owner/repo/issues/93",
		Summary:     "Track work ownership",
		Branch:      "issue-93/session-work",
		UpdatedAt:   "2026-11-20T12:00:00.123456789Z",
	}
	return scope, claim
}

func writeWorkClaimFixture(t *testing.T, scope protocol.Scope, claim protocol.WorkClaim) {
	t.Helper()
	if err := WriteWorkClaim(scope, claim); err != nil {
		t.Fatal(err)
	}
}

func writeWorkFixtureFile(t *testing.T, file string, contents []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(file, contents, mode); err != nil {
		t.Fatal(err)
	}
}

func assertWorkFileMode(t *testing.T, file string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != want {
		t.Errorf("%s permission = %o; want %o", file, info.Mode().Perm(), want)
	}
}

func assertWorkClaims(t *testing.T, scope protocol.Scope, want ...protocol.WorkClaim) {
	t.Helper()
	claims, err := ReadWorkClaims(scope)
	if err != nil {
		t.Fatal(err)
	}
	if claims == nil || len(claims) != len(want) {
		t.Fatalf("claims = %#v; want %#v", claims, want)
	}
	for _, claim := range want {
		if !slices.Contains(claims, claim) {
			t.Errorf("claim %#v missing from %#v", claim, claims)
		}
	}
}
