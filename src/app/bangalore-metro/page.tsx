import type { Metadata } from 'next';
import MetroMap from '@/components/metro/MetroMap';
import './metro.css';

export const metadata: Metadata = {
  title: 'Namma Metro — Bengaluru Transit Map',
  description:
    'A hand-tuned schematic map of Bengaluru\'s Namma Metro — Purple, Green and Yellow lines with live train animation, day/night mode and bilingual Kannada labels.',
};

export default function BangaloreMetroPage() {
  return <MetroMap />;
}
