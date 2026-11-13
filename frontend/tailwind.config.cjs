module.exports = {
            content: ["./index.html", "./src/**/*.{ts,js}"],
            theme: {
                extend: {
                    colors: {
                        paper: '#F7F7F5',
                        panels: '#FFFFFF',
                        fill: '#EEF0EB',
                        forest: '#1A3C2B',
                        secondary: '#62685F',
                        borders: '#DADDD5',
                        grid: '#E6E9E2',
                        'mint-pale': '#E8F3E8',
                        'amber-dark': '#865400',
                        'gold-pale': '#FFF3D2',
                        'red-dark': '#A3302A',
                        'coral-pale': '#FCEDEA',
                    },
                    fontFamily: {
                        mono: ['JetBrains Mono', 'monospace'],
                        heading: ['Space Grotesk', 'sans-serif'],
                        sans: ['system-ui', 'sans-serif'],
                    },
                    spacing: {
                        '2': '2px',
                        '4': '4px',
                        '6': '6px',
                        '8': '8px',
                        '12': '12px',
                        '16': '16px',
                        '20': '20px',
                        '24': '24px',
                        '32': '32px',
                    },
                    borderRadius: {
                        DEFAULT: '4px',
                    }
                }
            }
        };
