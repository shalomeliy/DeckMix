/**
 * The platform seams. `core/` and `app/` depend on these interfaces;
 * `platform/` provides the implementations. See
 * `docs/architecture/directions.md` for why each one exists.
 */
export type { AudioBackend, DeckBackend, DecodedAudio, AudioOutput, SetOutputResult } from '@/core/ports/audio'
export type { TrackSource, ScanProgress } from '@/core/ports/source'
export type { ControlTransport, TransportStatus, TransportDevice } from '@/core/ports/transport'
export type { Analyzer, AnalysisCache, TrackAnalysis, WaveformData, PcmData } from '@/core/ports/analyzer'
export type { Clock, Cancel } from '@/core/ports/clock'
export type { Persistence } from '@/core/ports/persistence'
export type { Capabilities } from '@/core/ports/capabilities'
export type { AIProvider, AISuggestion } from '@/core/ports/ai'
export type { SettingsStore } from '@/core/ports/settings'
export type { ArtistLookup, OnlineHit } from '@/core/ports/artist-lookup'
