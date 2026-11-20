package cli

import (
	"cmp"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const workFreshnessPeriod = 24 * time.Hour

// WorkRow joins a persisted assertion to the current discovery snapshot.
type WorkRow struct {
	protocol.WorkClaim
	InstanceIDs  []string `json:"instanceIds"`
	Availability string   `json:"availability"`
	Stale        bool     `json:"stale"`
	Conflict     bool     `json:"conflict"`
}

// ResolveWorkSession selects one registered launch and requires a live saved conversation.
func ResolveWorkSession(rows []Row, prefix string) (*protocol.Data, error) {
	if prefix == "" || len(prefix) > 32 || strings.Trim(prefix, "0123456789abcdef") != "" {
		return nil, errors.New("invalid work instance ID: use 1-32 lowercase hexadecimal characters")
	}
	var selected *Row
	for index := range rows {
		row := &rows[index]
		if row.Record == nil || !strings.HasPrefix(row.Record.InstanceID, prefix) {
			continue
		}
		if selected != nil {
			return nil, errors.New("work instance ID matches multiple registrations; use a longer ID")
		}
		selected = row
	}
	if selected == nil {
		return nil, errors.New("no matching work instance is registered in this scope")
	}
	if selected.Status == "unreachable" {
		return nil, errors.New("the selected instance is unreachable; select a current live instance")
	}
	data := workStatus(*selected)
	if data == nil {
		return nil, errors.New("could not verify the selected live instance identity; try again after checking its status")
	}
	if data.State != "running" {
		return nil, errors.New("the selected instance is not running normally; wait until it is ready")
	}
	if !hasSavedWorkSession(data) {
		return nil, errors.New("the selected instance has no verified saved conversation; save it first")
	}
	return data, nil
}

type workSession struct {
	scope string
	id    string
	file  string
}

type workLaunches struct {
	ids     []string
	running bool
}

// WorkDirectory projects the claims for a canonical URL, or all claims if url is empty.
func WorkDirectory(claims []protocol.WorkClaim, rows []Row, url string, now time.Time) []WorkRow {
	live := make(map[workSession]workLaunches)
	unresolved := make(map[workSession]bool)
	for _, row := range rows {
		if row.Record == nil || row.Status == "unreachable" {
			continue
		}
		data := workStatus(row)
		if data == nil || strings.TrimSpace(data.SessionID) == "" {
			unresolved[registeredWorkSession(row.Record)] = true
			continue
		}
		if data.SessionFile == nil || *data.SessionFile == "" {
			// The launch responded and currently has no saved conversation.
			continue
		}
		if !hasSavedWorkSession(data) {
			unresolved[registeredWorkSession(row.Record)] = true
			continue
		}
		session := workSession{
			scope: data.Scope,
			id:    data.SessionID,
			file:  *data.SessionFile,
		}
		launches := live[session]
		launches.ids = append(launches.ids, data.InstanceID)
		launches.running = launches.running || data.State == "running"
		live[session] = launches
	}
	for session, launches := range live {
		if len(launches.ids) > 1 {
			slices.Sort(launches.ids)
			launches.ids = slices.Compact(launches.ids)
		}
		live[session] = launches
	}

	claimCounts := make(map[[2]string]int)
	for _, claim := range claims {
		claimCounts[[2]string{claim.Scope, claim.URL}]++
	}

	directory := make([]WorkRow, 0, len(claims))
	for _, claim := range claims {
		if url != "" && url != claim.URL {
			continue
		}
		session := workSession{
			scope: claim.Scope,
			id:    claim.SessionID,
			file:  claim.SessionFile,
		}
		launches := live[session]
		ids := launches.ids
		if ids == nil {
			ids = []string{}
		}
		availability := "offline"
		switch {
		case len(ids) > 1:
			availability = "ambiguous"
		case hasUnresolvedWorkOwner(unresolved, session) || (len(ids) == 1 && !launches.running):
			availability = "unavailable"
		case len(ids) == 1:
			availability = "online"
		}
		updatedAt, err := time.Parse(time.RFC3339Nano, claim.UpdatedAt)
		directory = append(directory, WorkRow{
			WorkClaim:    claim,
			InstanceIDs:  ids,
			Availability: availability,
			Stale:        err != nil || now.Sub(updatedAt) > workFreshnessPeriod,
			Conflict:     len(ids) > 1 || claimCounts[[2]string{claim.Scope, claim.URL}] > 1,
		})
	}
	slices.SortFunc(directory, func(a, b WorkRow) int {
		return cmp.Or(
			strings.Compare(a.URL, b.URL),
			strings.Compare(a.Scope, b.Scope),
			strings.Compare(a.SessionID, b.SessionID),
			strings.Compare(a.SessionFile, b.SessionFile),
		)
	})
	return directory
}

func workStatus(row Row) *protocol.Data {
	if row.Status != "online" || row.Record == nil || row.Data == nil {
		return nil
	}
	if protocol.ValidateInstanceID(row.Record.InstanceID) != nil || row.Record.InstanceID != row.Data.InstanceID ||
		row.Record.Scope == "" || row.Record.Scope != row.Data.Scope {
		return nil
	}
	return row.Data
}

func hasSavedWorkSession(data *protocol.Data) bool {
	return strings.TrimSpace(data.SessionID) != "" && !strings.ContainsRune(data.SessionID, '\x00') &&
		data.SessionFile != nil && filepath.IsAbs(*data.SessionFile) && !strings.ContainsRune(*data.SessionFile, '\x00')
}

func registeredWorkSession(record *protocol.Record) workSession {
	session := workSession{
		scope: record.Scope,
		id:    record.SessionID,
	}
	if record.SessionFile != nil {
		session.file = *record.SessionFile
	}
	return session
}

func hasUnresolvedWorkOwner(unresolved map[workSession]bool, session workSession) bool {
	if len(unresolved) == 0 {
		return false
	}
	// Failed probes do not establish ownership; incomplete registrations can
	// leave several saved conversations in the same scope unverifiable.
	return unresolved[session] ||
		unresolved[workSession{
			scope: session.scope,
			id:    session.id,
		}] ||
		unresolved[workSession{
			scope: session.scope,
			file:  session.file,
		}] ||
		unresolved[workSession{
			scope: session.scope,
		}]
}
