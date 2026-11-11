# Engineering portfolio labs

Dos aplicaciones demostrativas de **Camilo Fuentealba**. Inspiradas en áreas de experiencia profesional, implementadas con datos ficticios y código independiente.

| Aplicación | Tecnologías | Qué demuestra | Inicio con Docker |
| --- | --- | --- | --- |
| [Payment Flow Lab](payment-flow-lab/) | NestJS, Angular, PostgreSQL/PGlite | Idempotencia, firma HMAC, deduplicación, outbox, SSE y auditoría | `cd payment-flow-lab && docker compose up --build` |
| [Browser Automation Lab](browser-automation-lab/) | Go, chromedp, Chromium, HTML/JS | Extracción real desde el DOM, reintento, timeout, cancelación y concurrencia | `cd browser-automation-lab && docker compose up --build` |

Pagos: http://localhost:4200 · Automatización: http://localhost:8080.

Cada carpeta incluye su README, Dockerfiles, Compose y pruebas. La [CI](https://github.com/camiloandresf/camiloandresf/actions/workflows/portfolio-labs.yml) valida builds, reglas de negocio, HTTP con PostgreSQL y recorridos con Chromium.

Estas aplicaciones necesitan backend. GitHub Pages sirve el portafolio estático; no ejecuta NestJS, Go, PostgreSQL ni Chromium. Para probar los laboratorios, clona el repositorio y ejecútalos localmente.

```bash
git clone https://github.com/camiloandresf/camiloandresf.git
cd camiloandresf/projects
```

Sugerencia para una entrevista: demuestra primero el flujo exitoso, luego repite una solicitud o provoca un timeout, y explica qué mantiene la consistencia del sistema ante ese caso.
