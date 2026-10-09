package cli

import (
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
	Request(protocol.Record, protocol.Request) (protocol.Response, error)
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
	var group sync.WaitGroup
	group.Add(len(records))
	for index := range records {
		index := index
		go func() {
			defer group.Done()
			rows[index] = listRecord(transport, records[index])
		}()
	}
	group.Wait()
	return rows, nil
}

func listRecord(transport Transport, record protocol.Record) Row {
	request, err := protocol.CreateRequest(record.InstanceID, "status")
	if err != nil {
		return Row{Record: &record, Status: "failed", Error: err.Error()}
	}
	response, err := transport.Request(record, request)
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
		return nil, errors.New("Choose exactly one of --all or --instance <id>.")
	}
	records, err := transport.ReadRecords()
	if err != nil {
		return nil, err
	}
	selected := records
	if !all {
		selected = nil
		for index := range records {
			if records[index].InstanceID == instanceID {
				selected = records[index : index+1]
				break
			}
		}
	}
	if len(selected) == 0 {
		return []Row{{InstanceID: instanceID, Status: "failed", Error: "No matching instance found."}}, nil
	}

	rows := make([]Row, len(selected))
	var group sync.WaitGroup
	group.Add(len(selected))
	for index := range selected {
		index := index
		go func() {
			defer group.Done()
			rows[index] = restartRecord(transport, selected[index])
		}()
	}
	group.Wait()
	return rows, nil
}

func restartRecord(transport Transport, record protocol.Record) Row {
	request, err := protocol.CreateRequest(record.InstanceID, "restart")
	if err != nil {
		return Row{InstanceID: record.InstanceID, Status: "failed", Error: err.Error()}
	}
	response, err := transport.Request(record, request)
	if err != nil {
		return Row{InstanceID: record.InstanceID, Status: outcomeForError(err), Error: err.Error()}
	}
	if !response.OK {
		return Row{
			InstanceID: record.InstanceID,
			Status:     "failed",
			Error:      response.Error.Message,
			ErrorCode:  response.Error.Code,
		}
	}
	return Row{InstanceID: record.InstanceID, Status: "accepted", Data: response.Data}
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

// FormatRows creates the tab-separated human-readable output used by the CLI.
func FormatRows(rows []Row) string {
	formatted := make([]string, len(rows))
	for index, row := range rows {
		id := row.InstanceID
		if id == "" && row.Record != nil {
			id = row.Record.InstanceID
		}
		if id == "" {
			id = "unknown"
		}
		details := row.Error
		if details == "" && row.Data != nil {
			details = row.Data.Message
			if details == "" {
				details = row.Data.State
			}
		}
		currentCWD := ""
		if row.Data != nil {
			currentCWD = row.Data.CWD
		}
		if currentCWD == "" && row.Record != nil {
			currentCWD = row.Record.CWD
		}
		cwd := ""
		if currentCWD != "" {
			cwd = " " + safeText(currentCWD)
		}
		restart := ""
		if row.Data != nil && row.Data.LastRestart != nil {
			restart = fmt.Sprintf(" completed-after-relaunch:%s:%s", safeText(row.Data.LastRestart.OperationID), safeText(row.Data.LastRestart.PreviousInstanceID))
		}
		lifecycle := ""
		if row.Data != nil {
			lifecycle = fmt.Sprintf(" launcher=%s canRestart=%t", managedLabel(row.Data.LauncherManaged), row.Data.CanRestart)
		}
		line := safeText(id) + "\t" + safeText(row.Status) + cwd + lifecycle + restart
		if details != "" {
			line += "\t" + safeText(details)
		}
		formatted[index] = line
	}
	return strings.Join(formatted, "\n")
}

func managedLabel(managed bool) string {
	if managed {
		return "managed"
	}
	return "unmanaged"
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
