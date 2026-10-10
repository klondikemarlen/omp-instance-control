package linux

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const (
	maxFrameBytes  = 64 * 1024
	requestTimeout = 5 * time.Second
	maxSocketPath  = 108
)

func validInstanceID(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}
	return true
}

// Transport discovers scoped records and sends requests over their Unix sockets.
type Transport struct {
	scope     protocol.Scope
	directory string
}

// RuntimeRoot returns the per-user Linux runtime root used by OMP instances.
func RuntimeRoot() (string, error) {
	if runtimeDirectory := os.Getenv("XDG_RUNTIME_DIR"); runtimeDirectory != "" {
		if !filepath.IsAbs(runtimeDirectory) {
			return "", errors.New("XDG_RUNTIME_DIR must be an absolute path")
		}
		return filepath.Join(runtimeDirectory, "omp-instance-control"), nil
	}
	return filepath.Join("/tmp", fmt.Sprintf("omp-instance-control-%d", os.Getuid())), nil
}

// EnsurePrivateDirectory creates or validates a private directory and its ancestors.
func EnsurePrivateDirectory(directory string) error {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return fmt.Errorf("resolve private directory: %w", err)
	}
	volume := filepath.VolumeName(absolute)
	root := volume + string(filepath.Separator)
	current := root
	for _, component := range strings.Split(strings.TrimPrefix(absolute, root), string(filepath.Separator)) {
		if component == "" {
			continue
		}
		current = filepath.Join(current, component)
		isPrivateLeaf := current == absolute
		if err := inspectDirectory(current, isPrivateLeaf); err != nil {
			return err
		}
	}
	return nil
}

func inspectDirectory(directory string, privateLeaf bool) error {
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		if mkdirErr := os.Mkdir(directory, 0o700); mkdirErr != nil && !errors.Is(mkdirErr, os.ErrExist) {
			return mkdirErr
		}
		info, err = os.Lstat(directory)
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("Unsafe runtime directory: %s is not a real directory", directory)
	}
	uid, err := fileOwnerUID(info)
	if err != nil {
		return err
	}
	if privateLeaf {
		if uid != uint32(os.Getuid()) || info.Mode().Perm()&0o077 != 0 {
			return fmt.Errorf("Unsafe runtime directory: %s is foreign-owned or accessible by other users", directory)
		}
		return nil
	}
	trustedOwner := uid == 0 || uid == uint32(os.Getuid())
	stickyTmp := directory == "/tmp" && uid == 0 && info.Mode()&os.ModeSticky != 0
	if !trustedOwner || (info.Mode().Perm()&0o022 != 0 && !stickyTmp) {
		return fmt.Errorf("Unsafe runtime directory ancestor: %s", directory)
	}
	return nil
}

func fileOwnerUID(info os.FileInfo) (uint32, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, errors.New("cannot inspect filesystem owner")
	}
	return stat.Uid, nil
}

func assertPrivateFile(file string) error {
	info, err := os.Lstat(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("Unsafe private file: %s is not a regular file", file)
	}
	uid, err := fileOwnerUID(info)
	if err != nil {
		return err
	}
	if uid != uint32(os.Getuid()) {
		return fmt.Errorf("Unsafe private file: %s is not owned by the current user", file)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("Unsafe private file: %s is accessible by other users", file)
	}
	return nil
}

// ReadPrivateJSON reads JSON only after a no-follow open and descriptor metadata check.
func ReadPrivateJSON(file string, value any) error {
	if err := assertPrivateFile(file); err != nil {
		return err
	}
	handle, err := os.OpenFile(file, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer handle.Close()

	info, err := handle.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("Unsafe private file: %s", file)
	}
	uid, err := fileOwnerUID(info)
	if err != nil {
		return err
	}
	if uid != uint32(os.Getuid()) || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("Unsafe private file: %s", file)
	}
	decoder := json.NewDecoder(handle)
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

// WritePrivateJSON atomically replaces a private JSON file via an exclusive 0600 temp file.
func WritePrivateJSON(file string, value any) error {
	if err := EnsurePrivateDirectory(filepath.Dir(file)); err != nil {
		return err
	}
	if err := assertPrivateFile(file); err != nil {
		return err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return fmt.Errorf("create temporary filename: %w", err)
	}
	temporary := fmt.Sprintf("%s.%d.%s.tmp", file, os.Getpid(), hex.EncodeToString(random[:]))
	handle, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	created := true
	defer func() {
		_ = handle.Close()
		if created {
			_ = os.Remove(temporary)
		}
	}()
	if err := writeAll(handle, encoded); err != nil {
		return err
	}
	if err := handle.Sync(); err != nil {
		return err
	}
	if err := handle.Close(); err != nil {
		return err
	}
	if err := assertPrivateFile(file); err != nil {
		return err
	}
	if err := os.Rename(temporary, file); err != nil {
		return err
	}
	created = false
	return nil
}

// NewTransport prepares the runtime and scope directories after validating their ancestors.
func NewTransport(scope protocol.Scope) (*Transport, error) {
	if scope.ID == "" {
		return nil, errors.New("Invalid transport scope identity")
	}
	runtimeRoot, err := RuntimeRoot()
	if err != nil {
		return nil, err
	}
	if err := EnsurePrivateDirectory(runtimeRoot); err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(scope.ID))
	directory := filepath.Join(runtimeRoot, hex.EncodeToString(digest[:])[:16])
	if err := EnsurePrivateDirectory(directory); err != nil {
		return nil, err
	}
	return &Transport{scope: scope, directory: directory}, nil
}

// ReadRecords reads a validated snapshot of records for this transport's scope.
func (transport *Transport) ReadRecords() ([]protocol.Record, error) {
	entries, err := os.ReadDir(transport.directory)
	if err != nil {
		return nil, err
	}
	records := make([]protocol.Record, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		instanceID := strings.TrimSuffix(name, ".json")
		if !validInstanceID(instanceID) {
			return nil, fmt.Errorf("Invalid instance record filename: %s", name)
		}
		var raw json.RawMessage
		file := filepath.Join(transport.directory, name)
		if err := ReadPrivateJSON(file, &raw); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		if err := validateRecordShape(raw); err != nil {
			return nil, err
		}
		var record protocol.Record
		if err := json.Unmarshal(raw, &record); err != nil {
			return nil, fmt.Errorf("Invalid instance record: %w", err)
		}
		if err := protocol.ValidateRecord(record, transport.scope); err != nil {
			return nil, err
		}
		if record.InstanceID != instanceID {
			return nil, fmt.Errorf("Instance record filename does not match identity: %s", name)
		}
		records = append(records, record)
	}
	return records, nil
}

func validateRecordShape(encoded []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil || fields == nil {
		return errors.New("Invalid instance record: expected an object")
	}
	for _, field := range []string{"version", "instanceId", "scope", "pid", "cwd", "sessionId", "sessionFile", "launcherManaged", "state", "operationId", "lastRestart"} {
		if _, exists := fields[field]; !exists {
			return fmt.Errorf("Invalid instance record fields: missing %s", field)
		}
	}
	if !isJSONNumber(fields["version"]) || !isJSONString(fields["instanceId"]) || !isJSONString(fields["scope"]) ||
		!isJSONNumber(fields["pid"]) || !isJSONString(fields["cwd"]) || !isJSONString(fields["sessionId"]) ||
		!isNullableString(fields["sessionFile"]) || !isJSONBool(fields["launcherManaged"]) || !isJSONString(fields["state"]) ||
		!isNullableString(fields["operationId"]) || !isNullableObject(fields["lastRestart"]) {
		return errors.New("Invalid instance record fields")
	}
	if isNullableObject(fields["lastRestart"]) && !bytes.Equal(bytes.TrimSpace(fields["lastRestart"]), []byte("null")) {
		var restart protocol.Restart
		if err := json.Unmarshal(fields["lastRestart"], &restart); err != nil {
			return fmt.Errorf("Invalid instance record restart metadata: %w", err)
		}
	}
	return nil
}

func isJSONNumber(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) > 0 && trimmed[0] != '"' && trimmed[0] != '{' && trimmed[0] != '[' &&
		!bytes.Equal(trimmed, []byte("null")) && (trimmed[0] == '-' || trimmed[0] >= '0' && trimmed[0] <= '9')
}

func isJSONString(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) > 0 && trimmed[0] == '"'
}

func isJSONBool(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return bytes.Equal(trimmed, []byte("true")) || bytes.Equal(trimmed, []byte("false"))
}

func isNullableString(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return bytes.Equal(trimmed, []byte("null")) || isJSONString(trimmed)
}

func isNullableObject(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return bytes.Equal(trimmed, []byte("null")) || len(trimmed) > 0 && trimmed[0] == '{'
}

// Request sends one bounded JSON frame and validates the correlated acknowledgement.
func (transport *Transport) Request(record protocol.Record, request protocol.Request) (protocol.Response, error) {
	if err := protocol.ValidateRecord(record, transport.scope); err != nil {
		return protocol.Response{}, err
	}
	if err := protocol.ValidateRequest(request); err != nil {
		return protocol.Response{}, err
	}
	if request.InstanceID != record.InstanceID {
		return protocol.Response{}, errors.New("Request instance does not match target record")
	}
	socket, err := socketPath(transport.directory, record.InstanceID)
	if err != nil {
		return protocol.Response{}, err
	}
	frame, err := json.Marshal(request)
	if err != nil {
		return protocol.Response{}, err
	}
	frame = append(frame, '\n')
	if len(frame) > maxFrameBytes {
		return protocol.Response{}, errors.New("IPC frame exceeds the maximum size")
	}
	deadline := time.Now().Add(requestTimeout)
	dialContext, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(dialContext, "unix", socket)
	if err != nil {
		return protocol.Response{}, err
	}
	defer connection.Close()
	if err := connection.SetDeadline(deadline); err != nil {
		return protocol.Response{}, err
	}
	if err := writeAll(connection, frame); err != nil {
		return protocol.Response{}, &AmbiguousError{Message: fmt.Sprintf("IPC request write failed; request outcome is unknown: %v", err)}
	}
	responseFrame, err := readFrame(connection)
	if err != nil {
		return protocol.Response{}, &AmbiguousError{Message: fmt.Sprintf("IPC acknowledgement unavailable; request outcome is unknown: %v", err)}
	}
	response, err := decodeResponse(responseFrame, request)
	if err != nil {
		return protocol.Response{}, &AmbiguousError{Message: fmt.Sprintf("Invalid IPC acknowledgement; request outcome is unknown: %v", err)}
	}
	return response, nil
}

// AmbiguousError means a request may have reached OMP but no valid acknowledgement arrived.
type AmbiguousError struct {
	Message string
}

func (e *AmbiguousError) Error() string { return e.Message }

func socketPath(directory, instanceID string) (string, error) {
	if !validInstanceID(instanceID) {
		return "", &protocol.Error{Code: "INVALID_INSTANCE", Message: "Expected a complete per-launch instance ID."}
	}
	result := filepath.Join(directory, instanceID+".sock")
	if len([]byte(result)) >= maxSocketPath {
		return "", fmt.Errorf("Unix socket path is too long (%d bytes): %s", len([]byte(result)), result)
	}
	return result, nil
}

func readFrame(connection net.Conn) ([]byte, error) {
	var frame []byte
	var chunk [4096]byte
	for {
		count, err := connection.Read(chunk[:])
		if count > 0 {
			bytesRead := chunk[:count]
			if newline := bytes.IndexByte(bytesRead, '\n'); newline >= 0 {
				if len(frame)+newline+1 > maxFrameBytes {
					return nil, errors.New("IPC response exceeds the maximum size")
				}
				frame = append(frame, bytesRead[:newline+1]...)
				return frame[:len(frame)-1], nil
			}
			if len(frame)+count > maxFrameBytes {
				return nil, errors.New("IPC response exceeds the maximum size")
			}
			frame = append(frame, bytesRead...)
		}
		if err != nil {
			return nil, err
		}
	}
}

func decodeResponse(encoded []byte, request protocol.Request) (protocol.Response, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil || fields == nil {
		return protocol.Response{}, errors.New("invalid control response object")
	}
	if !isJSONNumber(fields["version"]) || !isJSONString(fields["instanceId"]) || !isJSONString(fields["requestId"]) || !isJSONBool(fields["ok"]) {
		return protocol.Response{}, errors.New("control response has invalid identity or success fields")
	}
	var ok bool
	if err := json.Unmarshal(fields["ok"], &ok); err != nil {
		return protocol.Response{}, errors.New("control response must declare success or failure")
	}
	if ok {
		if !isNullableObject(fields["data"]) || bytes.Equal(bytes.TrimSpace(fields["data"]), []byte("null")) {
			return protocol.Response{}, errors.New("successful control response lacks structured data")
		}
	} else {
		var responseError map[string]json.RawMessage
		if err := json.Unmarshal(fields["error"], &responseError); err != nil || responseError == nil ||
			!isJSONString(responseError["code"]) || !isJSONString(responseError["message"]) {
			return protocol.Response{}, errors.New("failed control response lacks an error code and message")
		}
	}
	var response protocol.Response
	if err := json.Unmarshal(encoded, &response); err != nil {
		return protocol.Response{}, fmt.Errorf("decode control response: %w", err)
	}
	if err := protocol.ValidateResponse(response, request); err != nil {
		return protocol.Response{}, err
	}
	return response, nil
}

func writeAll(writer io.Writer, value []byte) error {
	for len(value) > 0 {
		count, err := writer.Write(value)
		if err != nil {
			return err
		}
		if count == 0 {
			return io.ErrShortWrite
		}
		value = value[count:]
	}
	return nil
}
