package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/klondikemarlen/omp-instance-control/cli"
	"github.com/klondikemarlen/omp-instance-control/linux"
)

const (
	restartAnimationInterval = 120 * time.Millisecond
	restartProgressFooter    = "OMP owns settlement; Ctrl-C stops watching only."
)

func restartRow(row cli.Row, showSession bool) progressLine {
	id := row.InstanceID
	if id == "" && row.Record != nil {
		id = row.Record.InstanceID
	}
	if id == "" {
		id = "unknown"
	}

	line := restartStatusText(row.Status) + "  " + displayInstanceID(id)
	if row.Data != nil && row.Data.Cooperative != nil {
		cooperative := row.Data.Cooperative
		line += "  " + safeTerminalText(cooperative.Phase)
		if cooperative.Message != "" {
			line += ": " + safeTerminalText(cooperative.Message)
		}
	}
	if row.Data != nil && row.Data.LastRestart != nil && row.Status == "restarted" {
		line += " -> " + displayInstanceID(row.Data.InstanceID)
	}
	lineInfo := progressLine{text: line, status: row.Status}
	if cwd := restartWorkingDirectory(row); cwd != "" {
		lineInfo.path = compactRestartPath(cwd)
	}
	if showSession {
		session := ""
		if row.Data != nil {
			session = row.Data.SessionID
		}
		if session == "" && row.Record != nil {
			session = row.Record.SessionID
		}
		if len(session) > 8 {
			session = session[len(session)-8:]
		}
		if session != "" {
			lineInfo.details = "session:" + safeTerminalText(session)
		}
	}
	if details := cli.ErrorSummary(row); details != "" {
		if lineInfo.details != "" {
			lineInfo.details += "  "
		}
		lineInfo.details += safeTerminalText(details)
	}
	return lineInfo
}

func restartWorkingDirectory(row cli.Row) string {
	if row.Data != nil && row.Data.CWD != "" {
		return row.Data.CWD
	}
	if row.Record != nil {
		return row.Record.CWD
	}
	return ""
}

func compactRestartPath(value string) string {
	path := filepath.Clean(safeTerminalText(value))
	if path == "." || path == string(filepath.Separator) {
		return path
	}
	parts := strings.Split(strings.Trim(path, string(filepath.Separator)), string(filepath.Separator))
	if len(parts) <= 2 {
		return path
	}
	return "..." + string(filepath.Separator) + strings.Join(parts[len(parts)-2:], string(filepath.Separator))
}

func displayInstanceID(value string) string {
	if len(value) == 32 {
		end := 12
		for end > 0 && !utf8.RuneStart(value[end]) {
			end--
		}
		value = value[:end]
	}
	return safeTerminalText(value)
}

func restartStatusText(status string) string {
	switch status {
	case "accepted":
		return "Accepted"
	case "waiting":
		return "Waiting"
	case "restarting":
		return "Restarting"
	case "blocked":
		return "Blocked"
	case "restarted":
		return "Restarted"
	default:
		return safeTerminalText(status)
	}
}

func safeTerminalText(value string) string {
	var out strings.Builder
	for _, character := range value {
		if character < 0x20 || (character >= 0x7f && character <= 0x9f) {
			fmt.Fprintf(&out, "\\u%04x", character)
		} else {
			out.WriteRune(character)
		}
	}
	return out.String()
}

func truncateTerminalText(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	if maxBytes <= 0 {
		return ""
	}

	suffix := ".."
	if maxBytes < len(suffix) {
		suffix = ""
	}
	limit := maxBytes - len(suffix)
	for limit > 0 && !utf8.RuneStart(value[limit]) {
		limit--
	}
	return value[:limit] + suffix
}

// Keep the project-name tail, not just its shared worktree-directory prefix.
// Bytes conservatively bound terminal cells, including wide Unicode characters.
func shortenRestartPath(value string, maximum int) string {
	if len(value) <= maximum {
		return value
	}
	if maximum <= 3 {
		return truncateTerminalText(value, maximum)
	}
	start := len(value) - maximum + 3
	for start < len(value) && !utf8.RuneStart(value[start]) {
		start++
	}
	return "..." + value[start:]
}

func progressLineText(line progressLine, maximum int) string {
	text := line.text
	if line.details != "" {
		text += "  " + line.details
	}
	if line.path != "" {
		available := maximum - len(text) - 2
		if available > 0 {
			text += "  " + shortenRestartPath(line.path, available)
		}
	}
	return truncateTerminalText(text, maximum)
}

type restartRenderer struct {
	file         *os.File
	canAnimate   bool
	useColors    bool
	startedAt    time.Time
	mu           sync.Mutex
	rowLines     []progressLine
	counts       restartRowCounts
	frame        []progressLine
	cursorHidden bool
	outcome      string
	previous     []string
	lineCount    int
	frameNumber  int
	stop         chan struct{}
	done         chan struct{}
}

func newRestartRenderer(file *os.File) *restartRenderer {
	_, _, hasTerminal := linux.TerminalSize(file)
	termIsDumb := os.Getenv("TERM") == "dumb"
	_, noColor := os.LookupEnv("NO_COLOR")
	return &restartRenderer{
		file:       file,
		canAnimate: hasTerminal && !termIsDumb,
		useColors:  hasTerminal && !termIsDumb && !noColor,
		startedAt:  time.Now(),
	}
}

func (renderer *restartRenderer) progress(rows []cli.Row) {
	renderer.mu.Lock()
	renderer.setRows(rows)
	renderer.drawLocked()
	renderer.mu.Unlock()
}

func (renderer *restartRenderer) showOutcome(rows []cli.Row, outcome string) {
	renderer.mu.Lock()
	renderer.setRows(rows)
	renderer.outcome = outcome
	renderer.drawLocked()
	renderer.mu.Unlock()
}

func (renderer *restartRenderer) setRows(rows []cli.Row) {
	pathCounts := make(map[string]int, len(rows))
	for _, row := range rows {
		pathCounts[restartWorkingDirectory(row)]++
	}
	renderer.rowLines = renderer.rowLines[:0]
	for _, row := range rows {
		showSession := pathCounts[restartWorkingDirectory(row)] > 1
		renderer.rowLines = append(renderer.rowLines, restartRow(row, showSession))
	}
	renderer.counts = countRestartRows(rows)
}

func (renderer *restartRenderer) startAnimation() {
	renderer.mu.Lock()
	if !renderer.canAnimate || renderer.stop != nil {
		renderer.mu.Unlock()
		return
	}

	renderer.stop = make(chan struct{})
	renderer.done = make(chan struct{})
	stop := renderer.stop
	done := renderer.done
	renderer.mu.Unlock()

	go func() {
		ticker := time.NewTicker(restartAnimationInterval)
		defer ticker.Stop()
		defer close(done)

		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				renderer.animate()
			}
		}
	}()
}

func (renderer *restartRenderer) animate() {
	renderer.mu.Lock()
	renderer.drawLocked()
	renderer.mu.Unlock()
}

func (renderer *restartRenderer) drawLocked() {
	columns, terminalRows, hasTerminal := linux.TerminalSize(renderer.file)
	if hasTerminal && columns > 0 && terminalRows > 0 && os.Getenv("TERM") != "dumb" {
		frame := renderer.terminalFrame(terminalRows)
		renderer.frameNumber++
		renderer.writeInPlace(frame, columns, terminalRows)
		return
	}
	if renderer.lineCount > 0 {
		fmt.Fprintln(renderer.file)
		renderer.lineCount = 0
		renderer.previous = nil
	}
	frame := renderer.plainFrame()
	lines := plainLines(frame)
	renderer.appendTransitions(lines)
}

func (renderer *restartRenderer) terminalFrame(terminalRows int) []progressLine {
	counts := renderer.counts

	footer := renderer.outcome
	if footer == "" {
		footer = restartProgressFooter
	}
	if terminalRows <= 2 {
		text := fmt.Sprintf(
			"%c %d/%d restarted, %d pending, %d issues, %d hidden, %s | %s",
			loaderFrames[renderer.frameNumber%len(loaderFrames)],
			counts.restarted,
			counts.total,
			counts.pending,
			counts.failed,
			counts.total,
			renderer.elapsed(),
			footer,
		)
		return []progressLine{{text: text}}
	}

	header := fmt.Sprintf(
		"%d/%d restarted | %d pending | %d issues | %s",
		counts.restarted,
		counts.total,
		counts.pending,
		counts.failed,
		renderer.elapsed(),
	)

	noteCount := 1
	if counts.pending > 0 {
		noteCount++
	}
	if counts.unreachable > 0 {
		noteCount++
	}
	maximumTargets := terminalRows - noteCount - 2
	if maximumTargets < 0 {
		maximumTargets = 0
	}
	lines := renderer.frame[:0]
	lines = append(lines, progressLine{text: header})
	var hidden int
	lines, hidden = appendVisibleRestartRows(lines, renderer.rowLines, maximumTargets)
	if hidden > 0 {
		lines[0].text += fmt.Sprintf(" | %d hidden", hidden)
	}
	lines = renderer.appendNotes(lines, footer, terminalRows-len(lines)-1)
	renderer.frame = lines
	return lines
}

func (renderer *restartRenderer) plainFrame() []progressLine {
	counts := renderer.counts
	header := fmt.Sprintf(
		"Restart progress | %d/%d restarted | %d pending | %d issues | %s",
		counts.restarted,
		counts.total,
		counts.pending,
		counts.failed,
		renderer.elapsed(),
	)

	footer := renderer.outcome
	if footer == "" {
		footer = restartProgressFooter
	}

	lines := renderer.frame[:0]
	lines = append(lines, progressLine{text: header})
	lines = append(lines, renderer.rowLines...)
	lines = renderer.appendNotes(lines, footer, 3)
	renderer.frame = lines
	return lines
}

func (renderer *restartRenderer) appendNotes(lines []progressLine, footer string, maximum int) []progressLine {
	if maximum <= 0 {
		return lines
	}
	lines = append(lines, progressLine{text: footer})
	maximum--
	if renderer.counts.unreachable > 0 && maximum > 0 {
		lines = append(lines, progressLine{text: "Possibly stale: run ompi control cleanup (safe, explicit cleanup)."})
		maximum--
	}
	if renderer.counts.pending > 0 && maximum > 0 {
		lines = append(lines, progressLine{text: "Waiting: a first saved response, active turns, queued work or jobs may defer restart."})
	}
	return lines
}

func (renderer *restartRenderer) writeInPlace(lines []progressLine, columns, terminalRows int) {
	if !renderer.cursorHidden {
		fmt.Fprint(renderer.file, "\x1b[?25l")
		renderer.cursorHidden = true
	}
	linesAbove := renderer.lineCount - 1
	if linesAbove >= terminalRows {
		linesAbove = terminalRows - 1
	}
	if linesAbove > 0 {
		fmt.Fprintf(renderer.file, "\x1b[%dA", linesAbove)
	}
	fmt.Fprint(renderer.file, "\r")
	for index, line := range lines {
		if index > 0 {
			fmt.Fprint(renderer.file, "\r\n")
		}
		fmt.Fprint(renderer.file, "\x1b[2K")
		maximum := columns - 1
		if isPendingRestartStatus(line.status) {
			maximum -= 2
		}
		text := progressLineText(line, maximum)
		if isPendingRestartStatus(line.status) && columns > 2 {
			text = string(loaderFrames[renderer.frameNumber%len(loaderFrames)]) + " " + text
		}
		if renderer.useColors {
			fmt.Fprint(renderer.file, colorizeRestartLine(text, line.status))
		} else {
			fmt.Fprint(renderer.file, text)
		}
	}

	previouslyVisibleLines := renderer.lineCount
	if previouslyVisibleLines > terminalRows {
		previouslyVisibleLines = terminalRows
	}
	extraLines := previouslyVisibleLines - len(lines)
	if extraLines > 0 {
		for range extraLines {
			fmt.Fprint(renderer.file, "\x1b[1B\r\x1b[2K")
		}
	}
	if len(lines) > renderer.lineCount {
		renderer.lineCount = len(lines)
	}
}

func (renderer *restartRenderer) appendTransitions(lines []string) {
	for index, line := range lines {
		if index >= len(renderer.previous) || renderer.previous[index] != line {
			fmt.Fprintln(renderer.file, line)
		}
	}
	renderer.previous = append(renderer.previous[:0], lines...)
}

func (renderer *restartRenderer) elapsed() string {
	seconds := int64(time.Since(renderer.startedAt).Seconds())
	hours := seconds / 3600
	minutes := (seconds % 3600) / 60
	remainder := seconds % 60
	return fmt.Sprintf("%02d:%02d:%02d", hours, minutes, remainder)
}

func (renderer *restartRenderer) close() {
	renderer.mu.Lock()
	stop := renderer.stop
	done := renderer.done
	renderer.stop = nil
	renderer.done = nil
	if stop != nil {
		close(stop)
	}
	renderer.mu.Unlock()

	if done != nil {
		<-done
	}

	renderer.mu.Lock()
	if renderer.lineCount > 0 {
		fmt.Fprintln(renderer.file)
		renderer.lineCount = 0
	}
	if renderer.cursorHidden {
		fmt.Fprint(renderer.file, "\x1b[?25h")
		renderer.cursorHidden = false
	}
	renderer.mu.Unlock()
}

type progressLine struct {
	text    string
	status  string
	path    string
	details string
}

type restartRowCounts struct {
	total       int
	restarted   int
	pending     int
	failed      int
	unreachable int
}

var loaderFrames = [...]rune{'|', '/', '-', '\\'}

func countRestartRows(rows []cli.Row) restartRowCounts {
	counts := restartRowCounts{total: len(rows)}
	for _, row := range rows {
		switch row.Status {
		case "restarted":
			counts.restarted++
		case "accepted", "waiting", "restarting":
			counts.pending++
		case "unreachable":
			counts.failed++
			counts.unreachable++
		case "failed", "unknown", "blocked":
			counts.failed++
		}
	}
	return counts
}

func appendVisibleRestartRows(lines []progressLine, rows []progressLine, maximum int) ([]progressLine, int) {
	if len(rows) <= maximum {
		for _, row := range rows {
			lines = append(lines, row)
		}
		return lines, 0
	}

	visibleCount := 0
	for _, row := range rows {
		if visibleCount == maximum {
			break
		}
		if isPendingRestartStatus(row.status) {
			lines = append(lines, row)
			visibleCount++
		}
	}
	for _, row := range rows {
		if visibleCount == maximum {
			break
		}
		if isPendingRestartStatus(row.status) {
			continue
		}
		lines = append(lines, row)
		visibleCount++
	}
	return lines, len(rows) - visibleCount
}

func isPendingRestartStatus(status string) bool {
	return status == "accepted" || status == "waiting" || status == "restarting"
}

func plainLines(lines []progressLine) []string {
	result := make([]string, len(lines))
	for index, line := range lines {
		result[index] = progressLineText(line, len(line.text)+len(line.details)+len(line.path)+4)
	}
	return result
}

func colorizeRestartLine(text, status string) string {
	color := ""
	switch status {
	case "restarted":
		color = "32"
	case "accepted", "waiting":
		color = "33"
	case "restarting":
		color = "36"
	case "unreachable", "failed", "unknown":
		color = "31"
	}
	if color == "" {
		return text
	}
	return "\x1b[" + color + "m" + text + "\x1b[0m"
}
