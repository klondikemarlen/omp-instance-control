package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/klondikemarlen/omp-instance-control/cli"
	"github.com/klondikemarlen/omp-instance-control/linux"
)

func restartRowText(row cli.Row) string {
	id := row.InstanceID
	if id == "" && row.Record != nil {
		id = row.Record.InstanceID
	}
	if id == "" {
		id = "unknown"
	}
	line := displayInstanceID(id) + "  " + restartStatusText(row.Status)
	cwd := ""
	if row.Data != nil {
		cwd = row.Data.CWD
	}
	if cwd == "" && row.Record != nil {
		cwd = row.Record.CWD
	}
	if row.Data != nil && row.Data.LastRestart != nil && row.Status == "restarted" {
		line += " -> " + displayInstanceID(row.Data.InstanceID)
	}
	if cwd != "" {
		line += "  " + safeTerminalText(cwd)
	}
	if row.Error != "" {
		line += "  " + safeTerminalText(row.Error)
	}
	return line
}

func displayInstanceID(value string) string {
	if len(value) == 32 {
		value = value[:12]
	}
	return safeTerminalText(value)
}

func restartStatusText(status string) string {
	switch status {
	case "accepted":
		return "Accepted (not completed)"
	case "waiting":
		return "Waiting for OMP to settle"
	case "restarting":
		return "Restarting"
	case "restarted":
		return "Restarted"
	default:
		return safeTerminalText(status)
	}
}

func safeTerminalText(value string) string {
	var out strings.Builder
	for _, r := range value {
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) {
			fmt.Fprintf(&out, "\\u%04x", r)
		} else {
			out.WriteRune(r)
		}
	}
	return out.String()
}

type restartRenderer struct {
	file         *os.File
	inPlace      bool
	lineCount    int
	previous     []string
	columns      int
	terminalRows int
}

func newRestartRenderer(file *os.File) *restartRenderer {
	renderer := &restartRenderer{file: file}
	if os.Getenv("TERM") == "dumb" {
		return renderer
	}
	columns, terminalRows, ok := linux.TerminalSize(file)
	renderer.inPlace = ok && columns > 0 && terminalRows > 2
	renderer.columns, renderer.terminalRows = columns, terminalRows
	return renderer
}

func (renderer *restartRenderer) progress(rows []cli.Row) {
	if renderer.inPlace {
		columns, terminalRows, ok := linux.TerminalSize(renderer.file)
		if !ok || columns != renderer.columns || terminalRows != renderer.terminalRows {
			renderer.finish()
			renderer.inPlace = false
		}
	}
	lines := make([]string, len(rows))
	for index, row := range rows {
		lines[index] = restartRowText(row)
	}
	if !renderer.inPlace || len(lines)+1 > renderer.terminalRows-1 || !renderer.fits(lines) {
		if renderer.inPlace {
			renderer.finish()
		}
		renderer.inPlace = false
		renderer.appendTransitions(lines)
		return
	}
	if renderer.lineCount > 0 {
		fmt.Fprintf(renderer.file, "\x1b[%dA", renderer.lineCount)
	}
	for _, line := range lines {
		fmt.Fprintf(renderer.file, "\r\x1b[2K%s\n", line)
	}
	renderer.lineCount = len(lines)
	renderer.previous = append(renderer.previous[:0], lines...)
}

func (renderer *restartRenderer) appendTransitions(lines []string) {
	for index, line := range lines {
		if index >= len(renderer.previous) || renderer.previous[index] != line {
			fmt.Fprintln(renderer.file, line)
		}
	}
	renderer.previous = append(renderer.previous[:0], lines...)
}

func (renderer *restartRenderer) fits(lines []string) bool {
	for _, line := range lines {
		if len(line) >= renderer.columns {
			return false
		}
		for _, r := range line {
			if r > 0x7e {
				return false
			}
		}
	}
	return true
}

func (renderer *restartRenderer) finish() {
	if renderer.lineCount > 0 {
		fmt.Fprint(renderer.file, "\n")
		renderer.lineCount = 0
	}
}
