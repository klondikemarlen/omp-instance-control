package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

func TestGetScopeMatchesJavaScriptScopeIdentityAndRelativeAgentOverride(t *testing.T) {
	t.Setenv("HOME", "/home/operator")
	t.Setenv("OMP_PROFILE", "")
	t.Setenv("PI_PROFILE", "")
	t.Setenv("PI_CONFIG_DIR", "config")
	t.Setenv("PI_CODING_AGENT_DIR", "relative-agent")

	scope, err := GetScope("", "/work/project")
	if err != nil {
		t.Fatal(err)
	}
	if scope.ConfigRoot != "/home/operator/config" {
		t.Fatalf("ConfigRoot = %q", scope.ConfigRoot)
	}
	if scope.Profile != "default" {
		t.Fatalf("Profile = %q", scope.Profile)
	}
	if scope.AgentDir != "/work/project/relative-agent" {
		t.Fatalf("AgentDir = %q", scope.AgentDir)
	}
	if scope.ID != "8e517bae258116e0" {
		t.Fatalf("scope ID = %q, want JavaScript-compatible hash 8e517bae258116e0", scope.ID)
	}
}

func TestGetScopeSerializationMatchesJavaScriptJSONStringify(t *testing.T) {
	lineSeparator := string(rune(0x2028))
	paragraphSeparator := string(rune(0x2029))
	home := "/home/operator<>&" + lineSeparator + `\u2028`
	cwd := "/work<>&" + lineSeparator + `\u2028`
	agentOverride := "agent<>&/" + paragraphSeparator + `\u2029`

	t.Setenv("HOME", home)
	t.Setenv("OMP_PROFILE", "")
	t.Setenv("PI_PROFILE", "")
	t.Setenv("PI_CONFIG_DIR", "config<>&")
	t.Setenv("PI_CODING_AGENT_DIR", agentOverride)

	scope, err := GetScope("", cwd)
	if err != nil {
		t.Fatal(err)
	}
	expectedJSON := `{"configRoot":"/home/operator<>&` + lineSeparator + `\\u2028/config<>&","profile":"default","agentDir":"/work<>&` + lineSeparator + `\\u2028/agent<>&/` + paragraphSeparator + `\\u2029"}`
	digest := sha256.Sum256([]byte(expectedJSON))
	expectedID := hex.EncodeToString(digest[:])[:16]
	if scope.ID != expectedID {
		t.Fatalf("scope identity = %q, want JavaScript JSON.stringify hash %q", scope.ID, expectedID)
	}
}

func TestGetScopeProfileSelectionAndValidation(t *testing.T) {
	t.Setenv("HOME", "/home/operator")
	t.Setenv("OMP_PROFILE", " work ")
	t.Setenv("PI_PROFILE", "ignored")
	t.Setenv("PI_CONFIG_DIR", "")
	t.Setenv("PI_CODING_AGENT_DIR", "ignored-agent")

	scope, err := GetScope("default", "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	if scope.Profile != "default" || scope.AgentDir != "/workspace/ignored-agent" {
		t.Fatalf("explicit default profile did not select default scope: %#v", scope)
	}

	_, err = GetScope("../other", "/workspace")
	if err == nil {
		t.Fatal("expected path-like profile to fail")
	}
	var protocolError *Error
	if !errors.As(err, &protocolError) || protocolError.Code != "INVALID_PROFILE" {
		t.Fatalf("unexpected profile error: %v", err)
	}
}

func TestCreateAndValidateRequests(t *testing.T) {
	instanceID := strings.Repeat("a", 32)
	request, err := CreateRequest(instanceID, "restart")
	if err != nil {
		t.Fatal(err)
	}
	if request.Version != Version || request.InstanceID != instanceID || request.Action != "restart" || len(request.RequestID) != 36 {
		t.Fatalf("unexpected request: %#v", request)
	}
	if err := ValidateRequest(Request{Version: Version, InstanceID: instanceID, RequestID: strings.Repeat("😀", 65), Action: "status"}); err == nil {
		t.Fatal("expected UTF-16-bounded request identifier to fail")
	}
	if err := ValidateRequest(Request{Version: Version, InstanceID: instanceID, RequestID: "r", Action: "reload"}); err == nil {
		t.Fatal("resource-only reload must remain unsupported")
	}
}

func TestValidateResponseRequiresCorrelatedStructuredAcknowledgement(t *testing.T) {
	request := Request{Version: Version, InstanceID: strings.Repeat("b", 32), RequestID: "request-1", Action: "restart"}
	valid := Response{Version: Version, InstanceID: request.InstanceID, RequestID: request.RequestID, OK: true, Data: &Data{State: "accepted"}}
	if err := ValidateResponse(valid, request); err != nil {
		t.Fatal(err)
	}

	wrongInstance := valid
	wrongInstance.InstanceID = strings.Repeat("c", 32)
	if err := ValidateResponse(wrongInstance, request); err == nil {
		t.Fatal("expected wrong instance acknowledgement to fail")
	}
	missingData := valid
	missingData.Data = nil
	if err := ValidateResponse(missingData, request); err == nil {
		t.Fatal("expected unstructured success acknowledgement to fail")
	}
	rejection := Response{Version: Version, InstanceID: request.InstanceID, RequestID: request.RequestID, Error: &Error{Code: "NOT_READY", Message: "Not ready"}}
	if err := ValidateResponse(rejection, request); err != nil {
		t.Fatalf("correlated rejection is valid protocol: %v", err)
	}
}

func TestGetScopeUsesHomeAndProfileAgentBoundaries(t *testing.T) {
	t.Setenv("HOME", "/home/operator")
	t.Setenv("PI_CONFIG_DIR", "/srv/omp-config")
	t.Setenv("PI_CODING_AGENT_DIR", "relative-agent")

	first, err := GetScope("work", "/one")
	if err != nil {
		t.Fatal(err)
	}
	second, err := GetScope("work", "/two")
	if err != nil {
		t.Fatal(err)
	}
	if first.AgentDir != "/srv/omp-config/profiles/work/agent" || first.AgentDir != second.AgentDir {
		t.Fatalf("named profile incorrectly used the default agent override: %#v %#v", first, second)
	}
	if first.ConfigRoot != "/srv/omp-config" || first.ID != second.ID {
		t.Fatalf("profile scopes should be independent of process cwd: %#v %#v", first, second)
	}

}
