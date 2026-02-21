import {
  pct,
  fmtNum,
  daysUntil,
  statusInfo,
  barColor,
  overallHealthColor,
  statusStyles,
  barStyles,
} from '../src/lib/quota-helpers';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pct', () => {
  it('should calculate percentage', () => {
    expect(pct(50, 100)).toBe(50);
    expect(pct(1, 4)).toBe(25);
  });

  it('should cap at 100', () => {
    expect(pct(200, 100)).toBe(100);
  });

  it('should return 0 when limit is 0', () => {
    expect(pct(50, 0)).toBe(0);
  });

  it('should return 0 when limit is negative', () => {
    expect(pct(50, -1)).toBe(0);
  });

  it('should round to nearest integer', () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(2, 3)).toBe(67);
  });
});

describe('fmtNum', () => {
  it('should return infinity symbol for -1', () => {
    expect(fmtNum(-1)).toBe('∞');
  });

  it('should format regular numbers', () => {
    expect(fmtNum(0)).toBe('0');
    expect(fmtNum(42)).toBe('42');
  });

  it('should format large numbers with locale', () => {
    const result = fmtNum(1000);
    // Locale formatting varies, but should contain "1" and "000"
    expect(result).toContain('1');
    expect(result).toContain('000');
  });
});

describe('daysUntil', () => {
  it('should return "Today" for past dates', () => {
    const yesterday = new Date(Date.now() - 864e5).toISOString();
    expect(daysUntil(yesterday)).toBe('Today');
  });

  it('should return "Today" for now', () => {
    expect(daysUntil(new Date().toISOString())).toBe('Today');
  });

  it('should return "Tomorrow" for tomorrow', () => {
    // Use slightly less than 1 day so Math.ceil rounds to exactly 1
    const tomorrow = new Date(Date.now() + 864e5 - 1000).toISOString();
    expect(daysUntil(tomorrow)).toBe('Tomorrow');
  });

  it('should return days for future dates', () => {
    const future = new Date(Date.now() + 5 * 864e5 - 1000).toISOString();
    expect(daysUntil(future)).toBe('5d');
  });
});

describe('statusInfo', () => {
  it('should return Unlimited/purple for limit -1', () => {
    const info = statusInfo(50, -1);
    expect(info.label).toBe('Unlimited');
    expect(info.color).toBe('purple');
  });

  it('should return Critical/red at 90%+', () => {
    const info = statusInfo(90, 100);
    expect(info.label).toBe('Critical');
    expect(info.color).toBe('red');
  });

  it('should return Warning/yellow at 70-89%', () => {
    const info = statusInfo(75, 100);
    expect(info.label).toBe('Warning');
    expect(info.color).toBe('yellow');
  });

  it('should return Healthy/green below 70%', () => {
    const info = statusInfo(50, 100);
    expect(info.label).toBe('Healthy');
    expect(info.color).toBe('green');
  });

  it('should return Healthy/green at 0%', () => {
    const info = statusInfo(0, 100);
    expect(info.label).toBe('Healthy');
    expect(info.color).toBe('green');
  });
});

describe('barColor', () => {
  it('should return blue for unlimited', () => {
    expect(barColor(0, 0, true)).toBe('bg-blue-500');
  });

  it('should return red at 90%+', () => {
    expect(barColor(95, 100, false)).toBe('bg-red-500');
  });

  it('should return yellow at 70-89%', () => {
    expect(barColor(80, 100, false)).toBe('bg-yellow-500');
  });

  it('should return green below 70%', () => {
    expect(barColor(30, 100, false)).toBe('bg-green-500');
  });
});

describe('overallHealthColor', () => {
  it('should return red when any quota is critical', () => {
    const quotas = {
      plugins: { used: 95, limit: 100 },
      pipelines: { used: 10, limit: 100 },
    };
    expect(overallHealthColor(quotas)).toBe('bg-red-500');
  });

  it('should return yellow when worst is warning', () => {
    const quotas = {
      plugins: { used: 75, limit: 100 },
      pipelines: { used: 10, limit: 100 },
    };
    expect(overallHealthColor(quotas)).toBe('bg-yellow-500');
  });

  it('should return green when all healthy', () => {
    const quotas = {
      plugins: { used: 30, limit: 100 },
      pipelines: { used: 20, limit: 100 },
    };
    expect(overallHealthColor(quotas)).toBe('bg-green-500');
  });

  it('should skip unlimited quotas', () => {
    const quotas = {
      plugins: { used: 9999, limit: -1 },
      pipelines: { used: 10, limit: 100 },
    };
    expect(overallHealthColor(quotas)).toBe('bg-green-500');
  });
});

describe('style maps', () => {
  it('should have styles for all status colors', () => {
    expect(statusStyles.green).toBeDefined();
    expect(statusStyles.yellow).toBeDefined();
    expect(statusStyles.red).toBeDefined();
    expect(statusStyles.purple).toBeDefined();
  });

  it('should have bar styles for all status colors', () => {
    expect(barStyles.green).toBe('bg-green-500');
    expect(barStyles.yellow).toBe('bg-yellow-500');
    expect(barStyles.red).toBe('bg-red-500');
    expect(barStyles.purple).toBe('bg-blue-500');
  });
});
