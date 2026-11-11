package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestFinalStateCannotBeOverwritten(t *testing.T) {
	j := &Job{snapshot: Snapshot{Status: "running"}}
	j.event("start", "Primero")
	j.finish("cancelled", "Cancelado", nil)
	j.finish("succeeded", "Tarde", []Account{{Name: "No"}})
	j.event("late", "Tarde")
	v := j.view()
	if v.Status != "cancelled" || len(v.Accounts) != 0 || len(v.Events) != 2 {
		t.Fatalf("estado final alterado: %+v", v)
	}
	v.Events[0].Message = "mutated"
	if j.view().Events[0].Message == "mutated" {
		t.Fatal("snapshot compartido")
	}
}
func TestConcurrentEventSequence(t *testing.T) {
	j := &Job{snapshot: Snapshot{Status: "running"}}
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); j.event("test", "ok") }()
	}
	wg.Wait()
	for i, e := range j.view().Events {
		if e.Sequence != i+1 {
			t.Fatal("secuencia inconsistente")
		}
	}
}
func TestAPIValidationAndAdmission(t *testing.T) {
	s := NewServer("http://127.0.0.1:8080")
	handler := s.routes()
	for _, body := range []string{`{}`, `{"scenario":"other"}`, `{"scenario":"success","url":"http://external"}`} {
		r := httptest.NewRecorder()
		handler.ServeHTTP(r, httptest.NewRequest("POST", "/api/runs", strings.NewReader(body)))
		if r.Code != 400 {
			t.Fatalf("body %s => %d", body, r.Code)
		}
	}
	s.active = "existing"
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("POST", "/api/runs", strings.NewReader(`{"scenario":"success"}`)))
	if w.Code != 429 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/runs/missing", nil))
	if w.Code != 404 {
		t.Fatal(w.Code)
	}
}
func TestBrowserScenarios(t *testing.T) {
	if os.Getenv("BROWSER_TESTS") != "1" {
		t.Skip("BROWSER_TESTS=1 requiere Chromium instalado")
	}
	s := NewServer("")
	server := httptest.NewServer(s.routes())
	defer server.Close()
	s.base = server.URL
	for _, scenario := range []string{"success", "retry", "timeout", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			requested := scenario
			if scenario == "cancel" {
				requested = "timeout"
			}
			response, err := http.Post(server.URL+"/api/runs", "application/json", bytes.NewBufferString(fmt.Sprintf(`{"scenario":%q}`, requested)))
			if err != nil {
				t.Fatal(err)
			}
			var snap Snapshot
			_ = json.NewDecoder(response.Body).Decode(&snap)
			response.Body.Close()
			if response.StatusCode != 202 {
				t.Fatal(response.Status)
			}
			if scenario == "cancel" {
				time.Sleep(time.Second)
				resp, e := http.Post(server.URL+"/api/runs/"+snap.ID+"/cancel", "application/json", nil)
				if e != nil {
					t.Fatal(e)
				}
				resp.Body.Close()
			}
			deadline := time.Now().Add(25 * time.Second)
			for time.Now().Before(deadline) {
				time.Sleep(100 * time.Millisecond)
				snap = s.job(snap.ID).view()
				if snap.Status != "running" {
					break
				}
			}
			expected := "succeeded"
			if scenario == "timeout" {
				expected = "timeout"
			}
			if scenario == "cancel" {
				expected = "cancelled"
			}
			if snap.Status != expected {
				t.Fatalf("esperado %s, recibido %+v", expected, snap)
			}
			if expected == "succeeded" && len(snap.Accounts) != 2 {
				t.Fatal("faltan cuentas")
			}
			if scenario == "retry" {
				found := false
				for _, e := range snap.Events {
					found = found || e.Step == "retry"
				}
				if !found {
					t.Fatal("faltó reintento")
				}
			}
			// Wait for allocator cleanup and admission release, not just terminal UI status.
			for {
				s.mu.Lock()
				active := s.active
				s.mu.Unlock()
				if active == "" {
					break
				}
				select {
				case <-time.After(20 * time.Millisecond):
				case <-context.Background().Done():
				}
				if time.Now().After(deadline) {
					t.Fatal("navegador no liberado")
				}
			}
		})
	}
}
