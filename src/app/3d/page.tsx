import type { Metadata } from 'next';
import MetroMap3D from '@/components/metro/MetroMap3D';
import './metro3d.css';

export const metadata: Metadata = {
  title: 'Namma Metro — 3D View',
  description:
    'Bengaluru\'s Namma Metro in 3D — elevated viaducts, underground tunnel sections and multi-coach trains running on the real IST timetable.',
};

export default function BangaloreMetro3DPage() {
  return <MetroMap3D />;
}
