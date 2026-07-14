'use client';

import { useEffect, useRef } from 'react';

// Utility to convert hex to RGB
function hexToRgb(hex: string) {
    const cleanHex = hex.replace('#', '');
    const r = parseInt(cleanHex.substring(0, 2), 16) || 0;
    const g = parseInt(cleanHex.substring(2, 4), 16) || 0;
    const b = parseInt(cleanHex.substring(4, 6), 16) || 0;
    return { r, g, b };
}

// Utility to interpolate between two RGB colors
function interpolateColor(color1: { r: number, g: number, b: number }, color2: { r: number, g: number, b: number }, factor: number) {
    const result = {
        r: Math.round(color1.r + factor * (color2.r - color1.r)),
        g: Math.round(color1.g + factor * (color2.g - color1.g)),
        b: Math.round(color1.b + factor * (color2.b - color1.b))
    };
    return result;
}

interface CanvasBackgroundProps {
    dotRadius: number;
    dotSpacing: number;
    waveSpeed: number;
    maxWaveHeight: number;
    interactionRadius: number;
    mouseRepelStrength: number;
    waveAngle: number;
    waveIntensity: number;
    waveEnabled: boolean;
    hoverColor: string;
    gradientFrom: string;
    gradientTo: string;
    backgroundColor?: string;
}

export default function CanvasBackground(props: CanvasBackgroundProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const propsRef = useRef(props);

    useEffect(() => {
        propsRef.current = props;
    }, [props]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        let animationFrameId: number;
        let width = 0;
        let height = 0;
        let dots: { baseX: number; baseY: number; offset: number; normalizedY: number; normalizedX: number }[] = [];
        let mouseX = -1000;
        let mouseY = -1000;
        let currentSpacing = propsRef.current.dotSpacing;

        const resize = () => {
            // Set actual size in memory (scaled to account for extra pixel density)
            const scale = window.devicePixelRatio || 1;
            width = window.innerWidth;
            height = window.innerHeight;

            canvas.width = Math.floor(width * scale);
            canvas.height = Math.floor(height * scale);

            // Normalize coordinate system to use css pixels
            ctx.scale(scale, scale);
            canvas.style.width = width + 'px';
            canvas.style.height = height + 'px';

            initDots(propsRef.current.dotSpacing);
        };

        const initDots = (spacing: number) => {
            currentSpacing = spacing;
            dots = [];
            const cols = Math.floor(width / spacing) + 2;
            const rows = Math.floor(height / spacing) + 2;
            const offsetX = (width - cols * spacing) / 2;
            const offsetY = (height - rows * spacing) / 2;

            for (let i = 0; i < cols; i++) {
                for (let j = 0; j < rows; j++) {
                    const baseX = i * spacing + offsetX;
                    const baseY = j * spacing + offsetY;

                    // Normalize position from 0 to 1 for gradient interpolation
                    const normalizedX = Math.max(0, Math.min(1, baseX / width));
                    const normalizedY = Math.max(0, Math.min(1, baseY / height));

                    dots.push({ baseX, baseY, offset: 0, normalizedX, normalizedY });
                }
            }
        };

        const render = (time: number) => {
            const p = propsRef.current;

            // Re-initialize dots smoothly if spacing changes
            if (p.dotSpacing !== currentSpacing) {
                initDots(p.dotSpacing);
            }

            // Background clear
            ctx.fillStyle = p.backgroundColor || '#050505';
            ctx.fillRect(0, 0, width, height);

            // Precompute wave angle direction vector
            const angleRad = (p.waveAngle * Math.PI) / 180;
            const dirX = Math.cos(angleRad);
            const dirY = Math.sin(angleRad);

            // Precompute gradient colors
            const colorFrom = hexToRgb(p.gradientFrom);
            const colorTo = hexToRgb(p.gradientTo);
            const hoverRgb = hexToRgb(p.hoverColor);

            for (let i = 0; i < dots.length; i++) {
                const dot = dots[i];

                // Calculate linear phase offset based on directional vector from center
                const cx = dot.baseX - width / 2;
                const cy = dot.baseY - height / 2;
                const dotPosition = cx * dirX + cy * dirY;
                const phaseOffset = dotPosition * p.waveIntensity;

                // Base directional wave motion
                const wave = p.waveEnabled ? Math.sin(phaseOffset - time * (p.waveSpeed * 2)) : 0;
                let yOffset = wave * p.maxWaveHeight;
                let scale = 1 + (wave * 0.3); // vary the size slightly
                let opacity = 0.4 + (wave * 0.2); // base opacity between 0.2 and 0.6

                // Base Color logic: Interpolate vertically to match CSS linear-gradient(to top)
                // (top of screen is y=0, bottom is y=height)
                // If gradient is to top: y=height is colorFrom, y=0 is colorTo
                const gradientFactor = 1 - dot.normalizedY;
                const baseColor = interpolateColor(colorFrom, colorTo, gradientFactor);

                let r = baseColor.r;
                let g = baseColor.g;
                let b = baseColor.b;

                // Mouse interaction
                const dx = dot.baseX - mouseX;
                const dy = dot.baseY - mouseY;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < p.interactionRadius) {
                    // Ripple effect based on mouse distance
                    const interactionFactor = 1 - Math.pow(distance / p.interactionRadius, 1.5); // non-linear dropoff

                    yOffset -= interactionFactor * p.mouseRepelStrength;
                    scale += interactionFactor * 1.5;
                    opacity += interactionFactor * 0.4;

                    // Shift color towards the hover hex color based on proximity
                    r = r + (hoverRgb.r - r) * interactionFactor;
                    g = g + (hoverRgb.g - g) * interactionFactor;
                    b = b + (hoverRgb.b - b) * interactionFactor;
                }

                ctx.fillStyle = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.max(0.1, Math.min(1, opacity))})`;
                ctx.beginPath();
                ctx.arc(dot.baseX, dot.baseY + yOffset, Math.max(0.2, p.dotRadius * scale), 0, Math.PI * 2);
                ctx.fill();
            }

            animationFrameId = requestAnimationFrame(render);
        };

        const handleMouseMove = (e: MouseEvent) => {
            mouseX = e.clientX;
            mouseY = e.clientY;
        };

        const handleMouseLeave = () => {
            // smooth reset
            mouseX = -1000;
            mouseY = -1000;
        };

        window.addEventListener('resize', resize);
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseleave', handleMouseLeave);

        // Initial setup
        resize();
        animationFrameId = requestAnimationFrame(render);

        return () => {
            window.removeEventListener('resize', resize);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseleave', handleMouseLeave);
            cancelAnimationFrame(animationFrameId);
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            className="fixed top-0 left-0 w-full h-full -z-10"
            style={{ display: 'block', pointerEvents: 'none', backgroundColor: props.backgroundColor || '#050505' }}
        />
    );
}
