package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/chromedp/chromedp"
)

//go:embed static/*
var assets embed.FS

type Event struct {
	Sequence int       `json:"sequence"`
	Step     string    `json:"step"`
	Message  string    `json:"message"`
	Time     time.Time `json:"time"`
}
type Account struct {
	Name    string `json:"name"`
	Balance string `json:"balance"`
}
type Snapshot struct {
	ID       string    `json:"id"`
	Scenario string    `json:"scenario"`
	Status   string    `json:"status"`
	Events   []Event   `json:"events"`
	Accounts []Account `json:"accounts"`
}
type Job struct {
	mu       sync.Mutex
	snapshot Snapshot
	cancel   context.CancelFunc
}

func (j *Job) view() Snapshot {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.snapshot
	s.Events = append([]Event{}, s.Events...)
	s.Accounts = append([]Account{}, s.Accounts...)
	return s
}
func (j *Job) event(step, msg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.snapshot.Status != "running" {
		return
	}
	j.snapshot.Events = append(j.snapshot.Events, Event{len(j.snapshot.Events) + 1, step, msg, time.Now().UTC()})
}
func (j *Job) finish(status, msg string, accounts []Account) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.snapshot.Status != "running" {
		return
	}
	j.snapshot.Status = status
	j.snapshot.Accounts = accounts
	j.snapshot.Events = append(j.snapshot.Events, Event{len(j.snapshot.Events) + 1, status, msg, time.Now().UTC()})
}

type Server struct {
	mu     sync.Mutex
	jobs   map[string]*Job
	active string
	next   uint64
	base   string
}

func NewServer(base string) *Server { return &Server{jobs: make(map[string]*Job), base: base} }
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (s *Server) job(id string) *Job { s.mu.Lock(); defer s.mu.Unlock(); return s.jobs[id] }
func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Scenario string `json:"scenario"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeJSON(w, 400, map[string]string{"error": "JSON inválido"})
		return
	}
	if input.Scenario != "success" && input.Scenario != "retry" && input.Scenario != "timeout" {
		writeJSON(w, 400, map[string]string{"error": "Escenario inválido"})
		return
	}
	s.mu.Lock()
	if s.active != "" {
		s.mu.Unlock()
		writeJSON(w, 429, map[string]string{"error": "Hay una ejecución activa. Espera o cancélala."})
		return
	}
	s.next++
	id := strconv.FormatUint(s.next, 10)
	ctx, cancel := context.WithTimeout(context.Background(), 18*time.Second)
	j := &Job{snapshot: Snapshot{ID: id, Scenario: input.Scenario, Status: "running", Events: []Event{}, Accounts: []Account{}}, cancel: cancel}
	// Bounded memory for this single-process lab. Never evict the active execution.
	if s.next > 30 {
		delete(s.jobs, strconv.FormatUint(s.next-30, 10))
	}
	s.jobs[id] = j
	s.active = id
	s.mu.Unlock()
	go func() {
		defer cancel()
		s.run(ctx, j)
		s.mu.Lock()
		if s.active == id {
			s.active = ""
		}
		s.mu.Unlock()
	}()
	writeJSON(w, 202, j.view())
}
func (s *Server) run(ctx context.Context, j *Job) {
	j.event("queued", "Preparando un navegador aislado")
	opts := append(chromedp.DefaultExecAllocatorOptions[:], chromedp.Flag("disable-dev-shm-usage", true))
	if path := os.Getenv("CHROME_BIN"); path != "" {
		opts = append(opts, chromedp.ExecPath(path))
	}
	if os.Getenv("CHROME_NO_SANDBOX") == "1" {
		opts = append(opts, chromedp.NoSandbox)
	}
	alloc, stopAlloc := chromedp.NewExecAllocator(ctx, opts...)
	defer stopAlloc()
	browser, stopBrowser := chromedp.NewContext(alloc)
	defer stopBrowser()
	var accounts []Account
	var err error
	for attempt := 1; attempt <= 2; attempt++ {
		j.event("navigation", fmt.Sprintf("Intento %d: abriendo el portal ficticio", attempt))
		url := fmt.Sprintf("%s/portal.html?scenario=%s&attempt=%d", s.base, j.view().Scenario, attempt)
		var temporary bool
		err = chromedp.Run(browser, chromedp.Navigate(url), chromedp.WaitVisible("#portal", chromedp.ByQuery), chromedp.Evaluate(`!!document.querySelector('#temporary')`, &temporary))
		if err == nil && temporary {
			err = errors.New("portal temporalmente no disponible")
			if attempt < 2 {
				j.event("retry", "Error transitorio detectado. Nuevo intento en 700 ms.")
				select {
				case <-ctx.Done():
					err = ctx.Err()
				case <-time.After(700 * time.Millisecond):
					continue
				}
			}
		}
		if err != nil {
			break
		}
		j.event("interaction", "Ingresando con el usuario ficticio demo / demo123")
		err = chromedp.Run(browser, chromedp.SendKeys("#user", "demo", chromedp.ByQuery), chromedp.SendKeys("#password", "demo123", chromedp.ByQuery), chromedp.Click("#login", chromedp.ByQuery), chromedp.WaitVisible("#accounts", chromedp.ByQuery))
		if err != nil {
			break
		}
		j.event("extraction", "Leyendo cuentas y saldos desde el DOM")
		err = chromedp.Run(browser, chromedp.Evaluate(`Array.from(document.querySelectorAll('[data-account]')).map(el=>({name:el.querySelector('.name').textContent.trim(),balance:el.querySelector('.balance').textContent.trim()}))`, &accounts))
		if err == nil && len(accounts) != 2 {
			err = errors.New("el portal devolvió una cantidad inesperada de cuentas")
		}
		break
	}
	if ctx.Err() != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			j.finish("timeout", "La consulta excedió el límite de 18 segundos", nil)
		} else {
			j.finish("cancelled", "Ejecución cancelada; navegador cerrado", nil)
		}
		return
	}
	if err != nil {
		j.finish("failed", "No se pudo completar la consulta: "+err.Error(), nil)
		return
	}
	j.finish("succeeded", "Consulta completada. Dos cuentas ficticias obtenidas.", accounts)
}
func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"status": "ok", "demo": true})
	})
	mux.HandleFunc("POST /api/runs", s.start)
	mux.HandleFunc("GET /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		j := s.job(r.PathValue("id"))
		if j == nil {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, 200, j.view())
	})
	mux.HandleFunc("POST /api/runs/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		j := s.job(r.PathValue("id"))
		if j == nil {
			http.NotFound(w, r)
			return
		}
		j.cancel()
		writeJSON(w, 202, map[string]bool{"requested": true})
	})
	mux.HandleFunc("GET /api/runs/{id}/events", func(w http.ResponseWriter, r *http.Request) {
		j := s.job(r.PathValue("id"))
		if j == nil {
			http.NotFound(w, r)
			return
		}
		f, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "stream no disponible", 500)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		ticker := time.NewTicker(300 * time.Millisecond)
		defer ticker.Stop()
		for {
			snap := j.view()
			b, _ := json.Marshal(snap)
			_, err := fmt.Fprintf(w, "data: %s\n\n", b)
			if err != nil {
				return
			}
			f.Flush()
			if snap.Status != "running" {
				return
			}
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
			}
		}
	})
	dir, _ := fs.Sub(assets, "static")
	mux.Handle("/", http.FileServer(http.FS(dir)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		mux.ServeHTTP(w, r)
	})
}
func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if _, err := strconv.Atoi(port); err != nil {
		log.Fatal("PORT inválido")
	}
	s := NewServer("http://127.0.0.1:" + port)
	server := &http.Server{Addr: ":" + port, Handler: s.routes(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		s.mu.Lock()
		for _, j := range s.jobs {
			j.cancel()
		}
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	log.Printf("Browser Automation Lab: http://localhost:%s (solo portal ficticio)", port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) && !strings.Contains(err.Error(), "closed") {
		log.Fatal(err)
	}
}
