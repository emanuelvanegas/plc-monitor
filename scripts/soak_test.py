#!/usr/bin/env python3
"""Isolated Linux soak test using only Python's standard library."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
IDS = ('demo-tank', 'demo-oven', 'demo-belt')
PLAN = (
    (.10, 'demo-tank', 'high'), (.20, 'demo-tank', 'normal'),
    (.30, 'demo-tank', 'offline'), (.40, 'demo-tank', 'normal'),
    (.50, 'demo-oven', 'pause'), (.60, 'demo-oven', 'resume'),
    (.70, 'demo-belt', 'slow'), (.80, 'demo-belt', 'normal'),
)


def utc():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def call(base, path, payload=None, download=None):
    request = Request(base + path, data=None if payload is None else json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json'}, method='GET' if payload is None else 'PUT')
    started = time.monotonic()
    with urlopen(request, timeout=10) as response:
        if download:
            with download.open('wb') as output:
                while chunk := response.read(65536):
                    output.write(chunk)
            result = None
        else:
            result = json.load(response)
    return result, (time.monotonic() - started) * 1000


def process_stats(pid):
    stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    cpu = (int(stat[11]) + int(stat[12])) / os.sysconf('SC_CLK_TCK')
    status = dict(line.split(':', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
    return {'cpu_seconds': cpu, 'rss_mb': int(status['VmRSS'].split()[0]) / 1024,
            'threads': int(status['Threads'])}


def verify_csv(path, plc_id):
    count = good = bad = 0
    with path.open(newline='') as source:
        for row in csv.DictReader(source):
            if row['id_equipo'] != plc_id:
                raise ValueError(f'CSV de {plc_id} contiene datos de otro PLC')
            if (row['calidad'] == 'good') != (row['valor'] != ''):
                raise ValueError(f'Valor y calidad incompatibles en CSV de {plc_id}')
            count += 1
            good += row['calidad'] == 'good'
            bad += row['calidad'] != 'good'
    if not count or not good:
        raise ValueError(f'CSV de {plc_id} sin lecturas válidas')
    return {'rows': count, 'good': good, 'failed': bad}


def inspect_database(path, start_ms, end_ms, actions):
    with sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True) as database:
        integrity = database.execute('PRAGMA integrity_check').fetchone()[0]
        counts = database.execute('SELECT plc_id,variable_id,quality,COUNT(*) FROM samples WHERE observed_at_ms BETWEEN ? AND ? GROUP BY plc_id,variable_id,quality', (start_ms, end_ms)).fetchall()
        events = database.execute('SELECT plc_id,kind,COUNT(*) FROM events GROUP BY plc_id,kind').fetchall()
        isolation = []
        pauses = []
        # After another PLC has entered an intentional fault or pause, the other
        # two must still have good readings for all three configured variables.
        for index, action in enumerate(actions):
            if action['scenario'] not in ('offline', 'pause', 'slow'):
                continue
            following = next((a for a in actions[index + 1:] if a['plc_id'] == action['plc_id']), None)
            if not following:
                continue
            begin, end = action['at_ms'] + 2000, following['at_ms'] - 1000
            if action['scenario'] == 'pause':
                rows = database.execute('SELECT COUNT(*) FROM samples WHERE plc_id=? AND observed_at_ms BETWEEN ? AND ?', (action['plc_id'], begin, end)).fetchone()[0]
                pauses.append({'plc_id': action['plc_id'], 'samples_while_paused': rows, 'passed': rows == 0})
            for other in IDS:
                if other == action['plc_id']:
                    continue
                variables = database.execute("SELECT COUNT(DISTINCT variable_id) FROM samples WHERE plc_id=? AND quality='good' AND observed_at_ms BETWEEN ? AND ?", (other, begin, end)).fetchone()[0]
                isolation.append({'during': action['scenario'], 'affected': action['plc_id'], 'other': other, 'good_variables': variables, 'passed': variables == 3})
    return {'integrity': integrity,
            'samples': [{'plc_id': p, 'variable_id': v, 'quality': q, 'count': n} for p, v, q, n in counts],
            'events': [{'plc_id': p, 'kind': k, 'count': n} for p, k, n in events],
            'isolation': isolation, 'pauses': pauses}


def main():
    parser = argparse.ArgumentParser(description='Prueba prolongada aislada de PLC Monitor (Linux).')
    parser.add_argument('--minutes', type=float, default=60, help='Duración medida; mínimo 2, máximo 120 (por defecto: 60).')
    parser.add_argument('--sample-seconds', type=float, default=5)
    parser.add_argument('--binary', type=Path, default=ROOT / 'target/release/plc-monitor')
    parser.add_argument('--output', type=Path, help='Directorio nuevo para el informe; por defecto reports/soak/<fecha UTC>.')
    args = parser.parse_args()
    if platform.system() != 'Linux':
        parser.error('La medición de recursos utiliza /proc de Linux.')
    if not 2 <= args.minutes <= 120 or not 1 <= args.sample_seconds <= 10:
        parser.error('Usa entre 2 y 120 minutos y muestras entre 1 y 10 segundos.')
    binary = args.binary.resolve()
    if not binary.is_file():
        parser.error('No existe el ejecutable. Ejecuta cargo build --release --locked o indica --binary.')
    if not (ROOT / 'frontend/dist/index.html').is_file():
        parser.error('Compila la interfaz: npm --prefix frontend run build')
    output = (args.output or ROOT / 'reports/soak' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')).resolve()
    output.mkdir(parents=True, exist_ok=False)
    database = output / 'monitor.db'
    log_path = output / 'backend.log'
    duration = args.minutes * 60
    summary = {'status': 'running', 'created_at': utc(), 'planned_seconds': duration,
               'poll_seconds': args.sample_seconds, 'platform': platform.platform(),
               'binary': str(binary), 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
               'conditions': '3 PLC simulados, 3 variables por PLC, intervalo 1 s; Modbus TCP loopback, SQLite; API consultada por este script, sin navegador automatizado',
               'actions': [], 'errors': [], 'exports': {}}
    write_json(output / 'summary.json', summary)
    samples = []
    scenario = {plc: 'normal' for plc in IDS}
    changed = {plc: 0.0 for plc in IDS}
    interrupted = False
    process = None
    base = None
    origin = None
    start_ms = end_ms = None
    print(f'Informe: {output}', flush=True)
    try:
        with log_path.open('w') as log:
            env = {**os.environ, 'RUST_LOG': 'plc_monitor=debug,tower_http=warn', 'NO_COLOR': '1'}
            process = subprocess.Popen([str(binary), '--demo', '--demo-base-port', '0', '--listen', '127.0.0.1:0',
                                        '--database', str(database), '--frontend', str(ROOT / 'frontend/dist')],
                                       cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=env)
            ready_deadline = time.monotonic() + 30
            while time.monotonic() < ready_deadline:
                if process.poll() is not None:
                    raise RuntimeError('El backend terminó durante el arranque; revisa backend.log')
                text = re.sub(r'\x1b\[[0-9;]*m', '', log_path.read_text(errors='replace'))
                match = re.search(r'address=127\.0\.0\.1:(\d+)', text)
                if match:
                    base = f'http://127.0.0.1:{match[1]}'
                    try:
                        call(base, '/api/health')
                        break
                    except (OSError, ValueError):
                        pass
                time.sleep(.2)
            else:
                raise RuntimeError('El backend no quedó disponible en 30 s')
            for plc in IDS:
                call(base, f'/api/demo/plcs/{plc}/scenario', {'scenario': 'normal'})
            warmup_deadline = time.monotonic() + 20
            while time.monotonic() < warmup_deadline:
                fleet, _ = call(base, '/api/plcs')
                if len(fleet['plcs']) == 3 and all(p['state']['connection'] == 'connected' and all(v['quality'] == 'good' for v in p['state']['variables'].values()) for p in fleet['plcs']):
                    break
                time.sleep(.2)
            else:
                raise RuntimeError('No se conectaron los tres simuladores durante el calentamiento')
            summary['url'] = base
            summary['configuration'] = fleet['plcs']
            summary['started_at'] = utc()
            start_ms = int(time.time() * 1000)
            origin = time.monotonic()
            previous_cpu = process_stats(process.pid)
            previous_at = origin
            next_poll = origin
            action_index = 0
            print(f'Demo de prueba: {base} · duración {args.minutes:g} min. Mantén esta terminal abierta.', flush=True)
            with (output / 'metrics.jsonl').open('w') as metrics:
                while (elapsed := time.monotonic() - origin) < duration:
                    if process.poll() is not None:
                        raise RuntimeError(f'El backend terminó con código {process.returncode}')
                    while action_index < len(PLAN) and elapsed >= duration * PLAN[action_index][0]:
                        fraction, plc, mode = PLAN[action_index]
                        path = f'/api/plcs/{plc}/acquisition' if mode in ('pause', 'resume') else f'/api/demo/plcs/{plc}/scenario'
                        payload = {'running': mode == 'resume'} if mode in ('pause', 'resume') else {'scenario': mode}
                        call(base, path, payload)
                        action = {'plc_id': plc, 'scenario': mode, 'at_ms': int(time.time() * 1000), 'elapsed_seconds': time.monotonic() - origin, 'planned_seconds': duration * fraction, 'observed': False}
                        summary['actions'].append(action)
                        scenario[plc] = 'normal' if mode == 'resume' else mode
                        changed[plc] = time.monotonic() - origin
                        action_index += 1
                        print(f'{elapsed / 60:5.1f} min: {plc} → {mode}', flush=True)
                    now = time.monotonic()
                    if now >= next_poll:
                        current = process_stats(process.pid)
                        row = {'at': utc(), 'elapsed_seconds': now - origin, **current,
                               'cpu_percent_one_core': None if not samples else (current['cpu_seconds'] - previous_cpu['cpu_seconds']) / max(now - previous_at, .001) * 100,
                               'database_bytes': sum(p.stat().st_size for p in (database, Path(str(database) + '-wal'), Path(str(database) + '-shm')) if p.exists())}
                        previous_cpu, previous_at = current, now
                        try:
                            health, row['health_ms'] = call(base, '/api/health')
                            fleet, row['fleet_ms'] = call(base, '/api/plcs')
                            row['health'] = health
                            row['plcs'] = fleet['plcs']
                            if health['status'] != 'ok' or health.get('storage_error'):
                                raise RuntimeError(f'Almacenamiento degradado: {health}')
                            for plc in fleet['plcs']:
                                plc_id = plc['id']
                                mode = scenario[plc_id]
                                states = plc['state']['variables']
                                primary = next(v['id'] for v in plc['variables'] if v['primary'])
                                good = all(v['quality'] == 'good' for v in states.values()) and len(states) == len(plc['variables'])
                                expected = (plc['paused'] if mode == 'pause' else
                                            plc['state']['connection'] == 'offline' if mode in ('offline', 'slow') else
                                            plc['state']['connection'] == 'connected' and good and states[primary]['alarm_active'] == (mode == 'high'))
                                if summary['actions']:
                                    action = next((a for a in reversed(summary['actions']) if a['plc_id'] == plc_id), None)
                                    if action and expected:
                                        action['observed'] = True
                                if mode in ('normal', 'high') and expected:
                                    last = datetime.fromisoformat(plc['state']['last_success'].replace('Z', '+00:00')).timestamp()
                                    if time.time() - last > 10:
                                        raise RuntimeError(f'{plc_id} lleva más de 10 s sin lecturas nuevas')
                                if not expected and elapsed - changed[plc_id] > 12:
                                    raise RuntimeError(f'{plc_id}: estado inesperado para {mode}')
                            # A five-minute chart query provides a real API latency sample.
                            if len(samples) % 6 == 0:
                                end = int(time.time() * 1000)
                                history, row['history_ms'] = call(base, f'/api/plcs/demo-tank/history?variable_id=tank-temperature&from_ms={end - 300000}&to_ms={end}')
                                row['history_points'] = len(history['samples'])
                        except (OSError, ValueError, KeyError, RuntimeError) as error:
                            row['error'] = str(error)
                            summary['errors'].append({'at': utc(), 'message': str(error)})
                        samples.append(row)
                        metrics.write(json.dumps(row, ensure_ascii=False) + '\n')
                        metrics.flush()
                        next_poll = now + args.sample_seconds
                        if len(samples) == 1 or int(elapsed / 60) > int((samples[-2]['elapsed_seconds'] if len(samples) > 1 else 0) / 60):
                            print(f'{elapsed / 60:5.1f} min · RSS {current["rss_mb"]:.1f} MB · {len(summary["errors"])} errores', flush=True)
                    time.sleep(min(.2, max(.01, duration - (time.monotonic() - origin))))
            end_ms = int(time.time() * 1000)
            summary['measured_seconds'] = time.monotonic() - origin
            final, _ = call(base, '/api/plcs')
            summary['final_fleet'] = final
            if not all(p['state']['connection'] == 'connected' and all(v['quality'] == 'good' for v in p['state']['variables'].values()) for p in final['plcs']):
                raise RuntimeError('La prueba terminó sin recuperar todos los PLC')
            # Finish pending writes before exporting so CSV and SQLite can be
            # compared over exactly the same measurement window.
            for plc in IDS:
                call(base, f'/api/plcs/{plc}/acquisition', {'running': False})
            for plc in IDS:
                file = output / f'{plc}.csv'
                _, export_ms = call(base, f'/api/plcs/{plc}/export.csv?from_ms={start_ms}&to_ms={end_ms}', download=file)
                summary['exports'][plc] = {**verify_csv(file, plc), 'duration_ms': export_ms}
    except KeyboardInterrupt:
        interrupted = True
        summary['errors'].append({'at': utc(), 'message': 'Interrumpido por el usuario; la duración no se completó'})
    except Exception as error:
        summary['errors'].append({'at': utc(), 'message': str(error)})
    finally:
        if process and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                summary['errors'].append({'at': utc(), 'message': 'El backend no cerró en 20 s; se terminó a la fuerza'})
        if process and process.returncode != 0:
            summary['errors'].append({'at': utc(), 'message': f'Código de salida del backend: {process.returncode}'})
        summary['finished_at'] = utc()
        if samples:
            summary['resources'] = {'rss_first_mb': samples[0]['rss_mb'], 'rss_last_mb': samples[-1]['rss_mb'],
                                    'rss_peak_mb': max(s['rss_mb'] for s in samples),
                                    'cpu_peak_percent_one_core': max((s['cpu_percent_one_core'] for s in samples if s['cpu_percent_one_core'] is not None), default=None),
                                    'database_peak_mb_including_wal': max(s['database_bytes'] for s in samples) / 1024**2,
                                    'cpu_average_percent_one_core': (samples[-1]['cpu_seconds'] - samples[0]['cpu_seconds']) / max(samples[-1]['elapsed_seconds'] - samples[0]['elapsed_seconds'], .001) * 100}
            summary['api_max_ms'] = {key: max((s[key] for s in samples if key in s), default=None) for key in ('health_ms', 'fleet_ms', 'history_ms')}
        if database.exists() and start_ms is not None:
            try:
                result = inspect_database(database, start_ms, end_ms or int(time.time() * 1000), summary['actions'])
                summary['database'] = result
                if result['integrity'] != 'ok' or any(not check['passed'] for check in result['isolation'] + result['pauses']):
                    summary['errors'].append({'at': utc(), 'message': 'Falló integridad SQLite, pausa o aislamiento entre PLC'})
                for plc, export in summary['exports'].items():
                    total = sum(s['count'] for s in result['samples'] if s['plc_id'] == plc)
                    if export['rows'] != total:
                        summary['errors'].append({'at': utc(), 'message': f'CSV y SQLite difieren para {plc}: {export["rows"]} / {total}'})
            except (OSError, sqlite3.Error) as error:
                summary['errors'].append({'at': utc(), 'message': f'No se pudo inspeccionar SQLite: {error}'})
        if len(summary['actions']) != len(PLAN) or any(not a['observed'] for a in summary['actions']):
            summary['errors'].append({'at': utc(), 'message': 'No se completaron y observaron todos los escenarios'})
        complete = summary.get('measured_seconds', 0) >= duration and len(summary['exports']) == 3
        summary['status'] = 'interrupted' if interrupted else 'passed' if complete and not summary['errors'] else 'failed'
        write_json(output / 'summary.json', summary)
        print(f'Resultado: {summary["status"]}. Informe: {output / "summary.json"}', flush=True)
    return 130 if interrupted else 0 if summary['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
