package linux

import (
	"os"
	"syscall"
	"unsafe"
)

// TerminalSize reports the terminal's columns and rows when file is a terminal
// with a known window size.
func TerminalSize(file *os.File) (columns, rows int, ok bool) {
	if !fileIsTerminal(file) {
		return 0, 0, false
	}
	var size struct {
		Rows uint16
		Cols uint16
		X    uint16
		Y    uint16
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), uintptr(syscall.TIOCGWINSZ), uintptr(unsafe.Pointer(&size)))
	if errno != 0 || size.Rows == 0 || size.Cols == 0 {
		return 0, 0, false
	}
	return int(size.Cols), int(size.Rows), true
}
