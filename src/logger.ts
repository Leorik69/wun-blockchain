/**
 * Blockchain Logger
 * 
 * Система логирования для отслеживания:
 * - Добавления транзакций
 * - Добычи блоков
 * - Ошибок валидации
 * - Производительности операций
 */

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  details?: Record<string, any>;
  duration?: number; // в миллисекундах
}

export class BlockchainLogger {
  private logs: LogEntry[] = [];
  private maxLogs: number = 10000; // максимум логов в памяти
  private minLevel: LogLevel = LogLevel.INFO;

  constructor(minLevel: LogLevel = LogLevel.INFO) {
    this.minLevel = minLevel;
  }

  /**
   * Логирует сообщение
   */
  private log(level: LogLevel, message: string, details?: Record<string, any>, duration?: number): void {
    // Проверяем минимальный уровень логирования
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    if (levels.indexOf(level) < levels.indexOf(this.minLevel)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      details,
      duration,
    };

    this.logs.push(entry);

    // Console output: single JSON line avoids format-string injection (Semgrep-safe).
    const consoleLine = JSON.stringify({
      at: new Date(entry.timestamp).toISOString(),
      level,
      message,
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(details ? { details } : {}),
    });
    console.log(consoleLine);

    // Удаляем старые логи если превышен лимит
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  /**
   * DEBUG логирование
   */
  public debug(message: string, details?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, message, details);
  }

  /**
   * INFO логирование
   */
  public info(message: string, details?: Record<string, any>): void {
    this.log(LogLevel.INFO, message, details);
  }

  /**
   * WARN логирование
   */
  public warn(message: string, details?: Record<string, any>): void {
    this.log(LogLevel.WARN, message, details);
  }

  /**
   * ERROR логирование
   */
  public error(message: string, details?: Record<string, any>): void {
    this.log(LogLevel.ERROR, message, details);
  }

  /**
   * Получить все логи
   */
  public getLogs(filter?: { level?: LogLevel; startTime?: number; endTime?: number }): LogEntry[] {
    let result = this.logs;

    if (filter?.level) {
      result = result.filter((log) => log.level === filter.level);
    }

    if (filter?.startTime) {
      result = result.filter((log) => log.timestamp >= filter.startTime!);
    }

    if (filter?.endTime) {
      result = result.filter((log) => log.timestamp <= filter.endTime!);
    }

    return result;
  }

  /**
   * Получить статистику логирования
   */
  public getStats(): {
    total: number;
    byLevel: Record<string, number>;
    oldestLog: number | null;
    newestLog: number | null;
  } {
    const stats: Record<string, number> = {
      DEBUG: 0,
      INFO: 0,
      WARN: 0,
      ERROR: 0,
    };

    this.logs.forEach((log) => {
      stats[log.level] = (stats[log.level] ?? 0) + 1;
    });

    const oldest = this.logs[0];
    const newest = this.logs[this.logs.length - 1];

    return {
      total: this.logs.length,
      byLevel: stats,
      oldestLog: oldest ? oldest.timestamp : null,
      newestLog: newest ? newest.timestamp : null,
    };
  }

  /**
   * Очистить логи
   */
  public clear(): void {
    this.logs = [];
  }

  /**
   * Экспортировать логи в JSON
   */
  public export(): string {
    return JSON.stringify(this.logs, null, 2);
  }
}
