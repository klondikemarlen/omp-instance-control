package linux

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"
)

const maxLegacySessionHeaderBytes = 64 << 10

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
	bytesRead := 0
	for recordIndex := range 2 {
		line, err := reader.ReadBytes('\n')
		bytesRead += len(line)
		if bytesRead > maxLegacySessionHeaderBytes {
			return "", false, nil
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return "", false, err
		}
		var header struct {
			Type string `json:"type"`
			ID   string `json:"id"`
			V    int    `json:"v"`
		}
		if err := json.Unmarshal(line, &header); err != nil {
			return "", false, nil
		}
		if header.Type == "session" && validRecoveryText(header.ID, 512) {
			return header.ID, true, nil
		}
		if recordIndex != 0 || header.Type != "title" || header.V != 1 || len(line) != 256 {
			return "", false, nil
		}
	}
	return "", false, nil
}
