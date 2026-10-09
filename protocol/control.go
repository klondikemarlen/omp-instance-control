package protocol

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf16"
)

const Version = 1

var (
	profilePattern  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
	instancePattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
)

// Scope identifies one OMP profile and agent directory for control discovery.
type Scope struct {
	ID         string `json:"id"`
	ConfigRoot string `json:"configRoot"`
	Profile    string `json:"profile"`
	AgentDir   string `json:"agentDir"`
}

// GetScope derives the same scope identity as the OMP JavaScript protocol.
// Empty profile and cwd arguments use the process environment and working directory.
func GetScope(profile, cwd string) (Scope, error) {
	envProfile := profile
	if envProfile == "" {
		var exists bool
		envProfile, exists = os.LookupEnv("OMP_PROFILE")
		if !exists {
			envProfile = os.Getenv("PI_PROFILE")
		}
		if envProfile == "" {
			envProfile = "default"
		}
	}
	normalizedProfile := strings.TrimSpace(envProfile)
	if normalizedProfile == "" {
		normalizedProfile = "default"
	}
	if !profilePattern.MatchString(normalizedProfile) {
		return Scope{}, &Error{Code: "INVALID_PROFILE", Message: "Profile names cannot contain paths or whitespace."}
	}

	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return Scope{}, fmt.Errorf("resolve current working directory: %w", err)
		}
	}
	absoluteCWD, err := filepath.Abs(cwd)
	if err != nil {
		return Scope{}, fmt.Errorf("resolve working directory: %w", err)
	}

	home := os.Getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
		if home == "" {
			currentUser, userErr := user.Current()
			if userErr != nil {
				return Scope{}, fmt.Errorf("resolve home directory: %w", userErr)
			}
			home = currentUser.HomeDir
		}
		if home == "" {
			return Scope{}, errors.New("resolve home directory: no home directory is available")
		}
	}
	absoluteHome, err := filepath.Abs(home)
	if err != nil {
		return Scope{}, fmt.Errorf("resolve home directory: %w", err)
	}

	configPart := os.Getenv("PI_CONFIG_DIR")
	if configPart == "" {
		configPart = ".omp"
	}
	configRoot := resolveFrom(absoluteHome, configPart)

	agentDir := ""
	if normalizedProfile == "default" {
		agentPart := os.Getenv("PI_CODING_AGENT_DIR")
		if agentPart == "" {
			agentPart = filepath.Join(configRoot, "agent")
		}
		agentDir = resolveFrom(absoluteCWD, agentPart)
	} else {
		agentDir = filepath.Join(configRoot, "profiles", normalizedProfile, "agent")
	}

	var identity bytes.Buffer
	identity.Grow(len(configRoot) + len(normalizedProfile) + len(agentDir) + 45)
	identity.WriteString(`{"configRoot":`)
	writeJSONString(&identity, configRoot)
	identity.WriteString(`,"profile":`)
	writeJSONString(&identity, normalizedProfile)
	identity.WriteString(`,"agentDir":`)
	writeJSONString(&identity, agentDir)
	identity.WriteByte('}')
	digest := sha256.Sum256(identity.Bytes())
	return Scope{
		ID:         hex.EncodeToString(digest[:])[:16],
		ConfigRoot: configRoot,
		Profile:    normalizedProfile,
		AgentDir:   agentDir,
	}, nil
}

// writeJSONString matches JSON.stringify without Go's HTML or line-separator escaping.
func writeJSONString(builder *bytes.Buffer, value string) {
	const hexadecimal = "0123456789abcdef"

	builder.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"':
			builder.WriteString(`\"`)
		case '\\':
			builder.WriteString(`\\`)
		case '\b':
			builder.WriteString(`\b`)
		case '\f':
			builder.WriteString(`\f`)
		case '\n':
			builder.WriteString(`\n`)
		case '\r':
			builder.WriteString(`\r`)
		case '\t':
			builder.WriteString(`\t`)
		default:
			if character < 0x20 {
				builder.WriteString(`\u00`)
				builder.WriteByte(hexadecimal[character>>4])
				builder.WriteByte(hexadecimal[character&0xf])
			} else {
				builder.WriteRune(character)
			}
		}
	}
	builder.WriteByte('"')
}

func resolveFrom(base, value string) string {
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return filepath.Clean(filepath.Join(base, value))
}

// Restart records the restart handoff committed by the previous launcher.
type Restart struct {
	OperationID        string `json:"operationId"`
	PreviousInstanceID string `json:"previousInstanceId"`
}

// Record is the private on-disk registration for one OMP process.
type Record struct {
	Version         int      `json:"version"`
	InstanceID      string   `json:"instanceId"`
	Scope           string   `json:"scope"`
	PID             int      `json:"pid"`
	CWD             string   `json:"cwd"`
	SessionID       string   `json:"sessionId"`
	SessionFile     *string  `json:"sessionFile"`
	LauncherManaged bool     `json:"launcherManaged"`
	State           string   `json:"state"`
	OperationID     *string  `json:"operationId"`
	LastRestart     *Restart `json:"lastRestart"`
}

// Request is one versioned operation addressed to a specific OMP process.
type Request struct {
	Version    int    `json:"version"`
	InstanceID string `json:"instanceId"`
	RequestID  string `json:"requestId"`
	Action     string `json:"action"`
}

// Error is a correlated protocol-level rejection returned by an OMP process.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// Data is the structured status or restart result supplied by an OMP process.
type Data struct {
	Version         int      `json:"version,omitempty"`
	InstanceID      string   `json:"instanceId,omitempty"`
	Scope           string   `json:"scope,omitempty"`
	PID             int      `json:"pid,omitempty"`
	CWD             string   `json:"cwd,omitempty"`
	SessionID       string   `json:"sessionId,omitempty"`
	SessionFile     *string  `json:"sessionFile,omitempty"`
	LauncherManaged bool     `json:"launcherManaged,omitempty"`
	State           string   `json:"state,omitempty"`
	OperationID     *string  `json:"operationId,omitempty"`
	LastRestart     *Restart `json:"lastRestart,omitempty"`
	CanRestart      bool     `json:"canRestart"`
	Message         string   `json:"message,omitempty"`
}

// Response is the identity-correlated acknowledgement to a control request.
type Response struct {
	Version    int    `json:"version"`
	InstanceID string `json:"instanceId"`
	RequestID  string `json:"requestId"`
	OK         bool   `json:"ok"`
	Data       *Data  `json:"data,omitempty"`
	Error      *Error `json:"error,omitempty"`
}

// ValidateInstanceID rejects identities that could escape an instance filename.
func ValidateInstanceID(instanceID string) error {
	if !instancePattern.MatchString(instanceID) {
		return &Error{Code: "INVALID_INSTANCE", Message: "Expected a complete per-launch instance ID."}
	}
	return nil
}

// CreateRequest creates a versioned status or restart request with a fresh UUID.
func CreateRequest(instanceID, action string) (Request, error) {
	if err := ValidateInstanceID(instanceID); err != nil {
		return Request{}, err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return Request{}, fmt.Errorf("create request identifier: %w", err)
	}
	random[6] = (random[6] & 0x0f) | 0x40
	random[8] = (random[8] & 0x3f) | 0x80
	requestID := fmt.Sprintf("%x-%x-%x-%x-%x", random[0:4], random[4:6], random[6:8], random[8:10], random[10:16])
	request := Request{
		Version:    Version,
		InstanceID: instanceID,
		RequestID:  requestID,
		Action:     action,
	}
	if err := ValidateRequest(request); err != nil {
		return Request{}, err
	}
	return request, nil
}

// ValidateRequest applies the same protocol version, identity, and action rules as OMP.
func ValidateRequest(request Request) error {
	if request.Version != Version {
		return &Error{Code: "UNSUPPORTED_VERSION", Message: "Unsupported control protocol version."}
	}
	if err := ValidateInstanceID(request.InstanceID); err != nil {
		return err
	}
	requestIDLength := 0
	for _, character := range request.RequestID {
		requestIDLength += utf16.RuneLen(character)
	}
	if request.RequestID == "" || requestIDLength > 128 {
		return &Error{Code: "INVALID_REQUEST", Message: "Expected a bounded nonempty request identifier."}
	}
	if request.Action != "status" && request.Action != "restart" {
		return &Error{Code: "UNSUPPORTED_ACTION", Message: "Only status and restart are supported; resource-only reload is unavailable."}
	}
	return nil
}

// ValidateResponse checks that a response is structurally valid and belongs to request.
func ValidateResponse(response Response, request Request) error {
	if response.Version != Version {
		return &Error{Code: "INVALID_RESPONSE", Message: "Invalid control response or protocol version."}
	}
	if response.InstanceID != request.InstanceID || response.RequestID != request.RequestID {
		return &Error{Code: "WRONG_INSTANCE", Message: "Control response does not match the requested launch and operation."}
	}
	if response.OK && response.Data == nil {
		return &Error{Code: "INVALID_RESPONSE", Message: "Successful control response lacks structured data."}
	}
	if !response.OK && response.Error == nil {
		return &Error{Code: "INVALID_RESPONSE", Message: "Failed control response lacks an error code and message."}
	}
	return nil
}

// ValidateRecord checks the fields required for a discoverable OMP instance.
func ValidateRecord(record Record, scope Scope) error {
	if record.Version != Version || ValidateInstanceID(record.InstanceID) != nil || record.Scope != scope.ID {
		return errors.New("Invalid instance record identity or scope")
	}
	if record.PID <= 0 || int64(record.PID) > 1<<53-1 {
		return fmt.Errorf("Invalid instance record fields: %s", record.InstanceID)
	}
	return nil
}
