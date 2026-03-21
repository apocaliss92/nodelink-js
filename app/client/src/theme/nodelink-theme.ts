import { createTheme, themeToCss } from 'camstack-ui/theme';

export const nodelinkTheme = createTheme({
  colors: {
    dark: {
      primary: '#3b82f6',
      primaryForeground: '#fafaf9',
      background: '#0c0a09',
      backgroundElevated: '#1c1917',
      surface: '#1c1917',
      surfaceHover: '#292524',
      border: '#292524',
      borderSubtle: '#1c1917',
      foreground: '#fafaf9',
      foregroundMuted: '#a8a29e',
      foregroundSubtle: '#78716c',
      foregroundDisabled: '#57534e',
      success: '#22c55e',
      warning: '#f59e0b',
      danger: '#ef4444',
      info: '#60a5fa',
    },
    light: {
      primary: '#2563eb',
      primaryForeground: '#fafaf9',
      background: '#fafaf9',
      backgroundElevated: '#ffffff',
      surface: '#f5f5f4',
      surfaceHover: '#e7e5e4',
      border: '#e7e5e4',
      borderSubtle: '#f5f5f4',
      foreground: '#1c1917',
      foregroundMuted: '#78716c',
      foregroundSubtle: '#a8a29e',
      foregroundDisabled: '#d6d3d1',
      success: '#16a34a',
      warning: '#d97706',
      danger: '#dc2626',
      info: '#3b82f6',
    },
  },
});

export const nodelinkThemeCss = themeToCss(nodelinkTheme);
