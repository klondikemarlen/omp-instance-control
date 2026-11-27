package cli

import (
	"context"
	"errors"
	"os"
	"sort"
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

// Row is the stable JSON result shape used by list, restart, and send commands.
type Row struct {
	Record             *protocol.Record `json:"record,omitempty"`
	InstanceID         string           `json:"instanceId,omitempty"`
	Status             string           `json:"status"`
	Data               *protocol.Data   `json:"data,omitempty"`
	Error              string           `json:"error,omitempty"`
	ErrorCode          string           `json:"errorCode,omitempty"`
	restartOperationID string
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

// SendMessage addresses one instance selected from a single discovery snapshot.
// A transport error after the request may mean the receiver accepted it, so it
// is reported as unknown and is never retried.
func SendMessage(transport Transport, instanceID, text, delivery string) (Row, error) {
	if instanceID == "" || len(instanceID) > 32 || strings.Trim(instanceID, "0123456789abcdef") != "" {
		return Row{}, errors.New("invalid send ID: use 1-32 lowercase hexadecimal characters")
	}
	if strings.TrimSpace(text) == "" {
		return Row{}, errors.New("message must not be empty")
	}
	if delivery != "followUp" && delivery != "steer" {
		return Row{}, errors.New("delivery must be followUp or steer")
	}
	if len(text) > 16*1024 {
		return Row{}, errors.New("message exceeds 16 KiB")
	}
	records, err := transport.ReadRecords()
	if err != nil {
		return Row{}, err
	}
	var selected *protocol.Record
	for index := range records {
		if !strings.HasPrefix(records[index].InstanceID, instanceID) {
			continue
		}
		if selected != nil {
			return Row{InstanceID: instanceID, Status: "failed", Error: "Instance ID prefix matches multiple instances; use a longer ID.", ErrorCode: "AMBIGUOUS_INSTANCE"}, nil
		}
		selected = &records[index]
	}
	if selected == nil {
		return Row{InstanceID: instanceID, Status: "failed", Error: "No matching instance found."}, nil
	}
	record := *selected
	request, err := protocol.CreateMessageRequest(record.InstanceID, text, delivery)
	if err != nil {
		return Row{Record: &record, InstanceID: record.InstanceID, Status: "failed", Error: err.Error()}, nil
	}
	response, err := transport.Request(context.Background(), record, request)
	if err != nil {
		return Row{Record: &record, InstanceID: record.InstanceID, Status: outcomeForError(err), Error: err.Error()}, nil
	}
	if !response.OK {
		return Row{Record: &record, InstanceID: record.InstanceID, Status: "failed", Error: response.Error.Message, ErrorCode: response.Error.Code}, nil
	}
	if response.Data == nil || response.Data.State != "submitted" || response.Data.MessageID != request.RequestID || response.Data.Delivery != delivery {
		return Row{Record: &record, InstanceID: record.InstanceID, Status: "unknown", Error: "Message submission acknowledgement did not match the request."}, nil
	}
	return Row{Record: &record, InstanceID: record.InstanceID, Status: "submitted", Data: response.Data}, nil
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

// FormatRows groups human-readable list results by working directory.
func FormatRows(rows []Row) string {
	byProject := make(map[string][]*Row)
	for index := range rows {
		row := &rows[index]
		cwd := ""
		if row.Data != nil {
			cwd = row.Data.CWD
		}
		if cwd == "" && row.Record != nil {
			cwd = row.Record.CWD
		}
		byProject[cwd] = append(byProject[cwd], row)
	}

	projects := make([]string, 0, len(byProject))
	for cwd := range byProject {
		projects = append(projects, cwd)
	}
	sort.Strings(projects)

	home, _ := os.UserHomeDir()
	var formatted strings.Builder
	for index, cwd := range projects {
		if index > 0 {
			formatted.WriteByte('\n')
		}
		writeProjectHeading(&formatted, cwd, home)
		for _, row := range byProject[cwd] {
			writeListRow(&formatted, row)
		}
	}
	return formatted.String()
}

func writeProjectHeading(formatted *strings.Builder, cwd, home string) {
	if cwd == "" {
		formatted.WriteString("unknown project")
		return
	}

	if home != "" {
		relative, matchesHome := strings.CutPrefix(cwd, strings.TrimRight(home, "/"))
		if matchesHome && (relative == "" || strings.HasPrefix(relative, "/")) {
			formatted.WriteByte('~')
			if cwd != "/" {
				writeSafeText(formatted, relative)
			}
			return
		}
	}
	writeSafeText(formatted, cwd)
}

func writeListRow(formatted *strings.Builder, row *Row) {
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
	if row.Status == "online" && row.Data != nil && row.Data.State != "" {
		state = row.Data.State
	}
	if state == "restart-requested" {
		state = "restart pending"
	}
	formatted.WriteString("\n  ")
	writeSafeText(formatted, id)
	formatted.WriteString("  ")
	writeSafeText(formatted, state)

	ompVersion := "unknown"
	if row.Status == "online" && row.Data != nil && strings.TrimSpace(row.Data.OMPVersion) != "" {
		ompVersion = row.Data.OMPVersion
	}
	formatted.WriteString("  OMP ")
	writeSafeText(formatted, ompVersion)

	if row.Status != "online" {
		if details := ErrorSummary(*row); details != "" {
			formatted.WriteString("  ")
			writeSafeText(formatted, details)
		}
		return
	}
	if row.Data == nil || row.Data.SessionTitle == nil {
		return
	}
	title := *row.Data.SessionTitle
	if strings.TrimSpace(title) == "" {
		return
	}
	formatted.WriteString("  ")
	writeSafeText(formatted, title)
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

func writeSafeText(formatted *strings.Builder, value string) {
	const hexDigits = "0123456789abcdef"
	for _, character := range value {
		if character < 0x20 || character >= 0x7f && character <= 0x9f {
			formatted.WriteString("\\u00")
			formatted.WriteByte(hexDigits[character>>4])
			formatted.WriteByte(hexDigits[character&0xf])
			continue
		}
		formatted.WriteRune(character)
	}
}
