package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"syscall"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

// Transport is the shared client surface implemented by Linux filesystem and IPC code.
type Transport interface {
	ReadRecords() ([]protocol.Record, error)
	Request(context.Context, protocol.Record, protocol.Request) (protocol.Response, error)
}

// Row is the stable JSON result shape used by list and restart commands.
type Row struct {
	Record     *protocol.Record `json:"record,omitempty"`
	InstanceID string           `json:"instanceId,omitempty"`
	Status     string           `json:"status"`
	Data       *protocol.Data   `json:"data,omitempty"`
	Error      string           `json:"error,omitempty"`
	ErrorCode  string           `json:"errorCode,omitempty"`
}

// ListInstances probes exactly the records in the transport snapshot.
func ListInstances(transport Transport) ([]Row, error) {
	records, err := transport.ReadRecords()
	if err != nil {
		return nil, err
	}
	rows := make([]Row, len(records))
	ctx := context.Background()
	var group sync.WaitGroup
	group.Add(len(records))
	for index := range records {
		index := index
		go func() {
			defer group.Done()
			rows[index] = listRecord(ctx, transport, records[index])
		}()
	}
	group.Wait()
	return rows, nil
}

func listRecord(ctx context.Context, transport Transport, record protocol.Record) Row {
	request, err := protocol.CreateRequest(record.InstanceID, "status")
	if err != nil {
		return Row{Record: &record, Status: "failed", Error: err.Error()}
	}
	response, err := transport.Request(ctx, record, request)
	if err != nil {
		return Row{Record: &record, Status: outcomeForError(err), Error: err.Error()}
	}
	if !response.OK {
		return Row{
			Record:    &record,
			Status:    "failed",
			Error:     response.Error.Message,
			ErrorCode: response.Error.Code,
		}
	}
	return Row{Record: &record, Status: "online", Data: response.Data}
}

// RestartInstances restarts one selected record or broadcasts to the snapshot when all is true.
func RestartInstances(transport Transport, all bool, instanceID string) ([]Row, error) {
	if all == (instanceID != "") {
		return nil, errors.New("Choose one restart target: an instance ID or all.")
	}
	records, err := transport.ReadRecords()
	if err != nil {
		return nil, err
	}
	selected := records
	if !all {
		matchIndex := -1
		for index := range records {
			if !strings.HasPrefix(records[index].InstanceID, instanceID) {
				continue
			}
			if matchIndex >= 0 {
				return []Row{{
					InstanceID: instanceID,
					Status:     "failed",
					Error:      "Instance ID prefix matches multiple instances; use a longer ID.",
					ErrorCode:  "AMBIGUOUS_INSTANCE",
				}}, nil
			}
			matchIndex = index
		}
		selected = nil
		if matchIndex >= 0 {
			selected = records[matchIndex : matchIndex+1]
		}
	}
	if len(selected) == 0 {
		return []Row{{InstanceID: instanceID, Status: "failed", Error: "No matching instance found."}}, nil
	}

	rows := make([]Row, len(selected))
	ctx := context.Background()
	var group sync.WaitGroup
	group.Add(len(selected))
	for index := range selected {
		index := index
		go func() {
			defer group.Done()
			rows[index] = restartRecord(ctx, transport, selected[index])
		}()
	}
	group.Wait()
	return rows, nil
}

func restartRecord(ctx context.Context, transport Transport, record protocol.Record) Row {
	request, err := protocol.CreateRequest(record.InstanceID, "restart-wrapper")
	if err != nil {
		return Row{Record: &record, InstanceID: record.InstanceID, Status: "failed", Error: err.Error()}
	}
	response, err := transport.Request(ctx, record, request)
	if err != nil {
		return Row{Record: &record, InstanceID: record.InstanceID, Status: outcomeForError(err), Error: err.Error()}
	}
	if !response.OK {
		return Row{
			Record:     &record,
			InstanceID: record.InstanceID,
			Status:     "failed",
			Error:      response.Error.Message,
			ErrorCode:  response.Error.Code,
		}
	}
	return Row{Record: &record, InstanceID: record.InstanceID, Status: "accepted", Data: response.Data}
}

func outcomeForError(err error) string {
	if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) {
		return "unreachable"
	}
	var protocolError *protocol.Error
	if errors.As(err, &protocolError) {
		return "failed"
	}
	return "unknown"
}

// FormatRows creates compact operational output; JSON retains diagnostic details.
func FormatRows(rows []Row) string {
	var formatted strings.Builder
	for index, row := range rows {
		if index > 0 {
			formatted.WriteByte('\n')
		}
		id := row.InstanceID
		if id == "" && row.Record != nil {
			id = row.Record.InstanceID
		}
		if id == "" {
			id = "unknown"
		}
		if len(id) == 32 {
			id = id[:12]
		}
		state := row.Status
		if state == "online" && row.Data != nil && row.Data.State != "" {
			state = row.Data.State
		}
		if state == "restart-requested" {
			state = "restart pending"
		}
		formatted.WriteString(safeText(id))
		formatted.WriteString("  ")
		formatted.WriteString(safeText(state))
		cwd := ""
		if row.Data != nil {
			cwd = row.Data.CWD
		}
		if cwd == "" && row.Record != nil {
			cwd = row.Record.CWD
		}
		if cwd != "" {
			formatted.WriteString("  ")
			formatted.WriteString(safeText(compactProjectPath(cwd)))
		}
		if row.Status == "online" && row.Data != nil && row.Data.LastRestart != nil {
			formatted.WriteString("  (previous restart completed)")
		}
		if details := ErrorSummary(row); details != "" {
			formatted.WriteString("  ")
			formatted.WriteString(safeText(details))
		}
	}
	return formatted.String()
}

func compactProjectPath(value string) string {
	trimmed := strings.TrimRight(value, "/")
	last := strings.LastIndex(trimmed, "/")
	if last <= 0 {
		return value
	}
	parent := strings.LastIndex(trimmed[:last], "/")
	if parent <= 0 {
		return value
	}
	return "..." + trimmed[parent:]
}

// ErrorSummary omits socket internals from human output, not from JSON results.
func ErrorSummary(row Row) string {
	if row.Status == "unreachable" {
		if strings.Contains(row.Error, "connect ENOENT") || strings.HasSuffix(row.Error, "no such file or directory") {
			return "socket missing"
		}
		if strings.Contains(row.Error, "connect ECONNREFUSED") || strings.HasSuffix(row.Error, "connection refused") {
			return "connection refused"
		}
		return "endpoint unavailable"
	}
	return row.Error
}

func safeText(value string) string {
	var escaped strings.Builder
	for _, character := range value {
		if character < 0x20 || character >= 0x7f && character <= 0x9f {
			escaped.WriteString(fmt.Sprintf("\\u%04x", character))
			continue
		}
		escaped.WriteRune(character)
	}
	return escaped.String()
}
