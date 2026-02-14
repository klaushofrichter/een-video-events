<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, inject, type Ref } from 'vue'
import {
  useAuthStore,
  getCameras,
  getRecordedImage,
  formatTimestamp,
  listEventFieldValues,
  listEvents,
  createEventSubscription,
  connectToEventSubscription,
  deleteEventSubscription,
  getIncludeParameterForEventTypes
} from 'een-api-toolkit'
import type { Camera, SSEEvent, SSEConnection, SSEConnectionStatus } from 'een-api-toolkit'
import LivePlayer from '@een/live-video-web-sdk'

const authStore = useAuthStore()
const isAuthenticated = computed(() => authStore.isAuthenticated)

// Camera state
const cameras = ref<Camera[]>([])
const selectedCameraId = ref<string>('')
const loading = ref(false)
const error = ref<string | null>(null)

// Live video state
const videoRef = ref<HTMLVideoElement | null>(null)
const streamLoading = ref(false)
const streamError = ref<string | null>(null)
const videoKey = ref(0)
let livePlayer: LivePlayer | null = null
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// SSE event feed state
const sseEvents = ref<SSEEvent[]>([])
const sseStatus = ref<SSEConnectionStatus>('disconnected')
const sseError = ref<string | null>(null)
const sseLoading = ref(false)
let sseConnection: SSEConnection | null = null
let currentSubscriptionId: string | null = null
const MAX_SSE_EVENTS = 100
const soundEnabled = inject<Ref<boolean>>('soundEnabled', ref(true))

// Event type filter state
const availableEventTypes = ref<string[]>([])
const selectedEventTypes = ref<string[]>([])
const eventFilterOpen = ref(false)

function playEventSound() {
  if (!soundEnabled.value) return
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.value = 0.15
    osc.start()
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
    osc.stop(ctx.currentTime + 0.15)
  } catch {
    // Audio not available
  }
}

// Modal state for event preview image
const modalOpen = ref(false)
const modalImage = ref<string | null>(null)
const modalLoading = ref(false)
const modalEvent = ref<SSEEvent | null>(null)

interface BoundingBoxOverlay {
  x: number  // percentage
  y: number
  width: number
  height: number
  label?: string
}

const modalBoundingBoxes = ref<BoundingBoxOverlay[]>([])

// Live video bounding box overlay state
const videoBoundingBoxes = ref<BoundingBoxOverlay[]>([])
let videoBoxTimer: ReturnType<typeof setTimeout> | null = null

/** Extract bounding boxes from event data array */
function extractBoundingBoxes(event: SSEEvent): BoundingBoxOverlay[] {
  if (!event.data || !Array.isArray(event.data)) return []

  // Build objectId → label map from classification data
  const labelMap = new Map<string, string>()
  for (const item of event.data) {
    if (item.type === 'een.objectClassification.v1' && item.objectId && item.label) {
      labelMap.set(item.objectId as string, item.label as string)
    }
  }

  const boxes: BoundingBoxOverlay[] = []
  for (const item of event.data) {
    if (item.type === 'een.objectDetection.v1' && Array.isArray(item.boundingBox)) {
      const bb = item.boundingBox as number[]
      if (bb.length === 4 && bb.every(v => typeof v === 'number')) {
        const [x1, y1, x2, y2] = bb
        boxes.push({
          x: x1 * 100,
          y: y1 * 100,
          width: (x2 - x1) * 100,
          height: (y2 - y1) * 100,
          label: item.objectId ? labelMap.get(item.objectId as string) : undefined
        })
      }
    }
  }
  return boxes
}

async function handleEventClick(event: SSEEvent) {
  modalEvent.value = event
  modalOpen.value = true
  modalLoading.value = true
  modalImage.value = null
  modalBoundingBoxes.value = []

  // Try extracting bounding boxes from existing event data (historical backfill includes them)
  let boxes = extractBoundingBoxes(event)

  // If no boxes found and event type supports data schemas, fetch enriched event
  if (boxes.length === 0) {
    const includeParams = getIncludeParameterForEventTypes([event.type])
    if (includeParams.length > 0) {
      const eventResult = await listEvents({
        actor: `camera:${selectedCameraId.value}`,
        type__in: [event.type],
        startTimestamp__gte: formatTimestamp(event.startTimestamp),
        startTimestamp__lte: formatTimestamp(event.startTimestamp),
        include: includeParams,
        pageSize: 1
      })
      const enrichedEvent = eventResult.data?.results?.find((e: any) => e.id === event.id)
      if (enrichedEvent) {
        boxes = extractBoundingBoxes(enrichedEvent as unknown as SSEEvent)
      }
    }
  }

  modalBoundingBoxes.value = boxes

  const result = await getRecordedImage({

    deviceId: selectedCameraId.value,
    timestamp__gte: formatTimestamp(event.startTimestamp),
    type: 'preview'
  })

  if (result.data?.imageData) {
    modalImage.value = result.data.imageData
  }
  modalLoading.value = false
}

function closeModal() {
  modalOpen.value = false
  modalImage.value = null
  modalEvent.value = null
  modalBoundingBoxes.value = []
}

/** Flash bounding boxes on live video for a recent SSE event */
async function flashVideoBoxes(event: SSEEvent) {
  const eventAge = Date.now() - new Date(event.startTimestamp).getTime()
  if (eventAge > 5000) return

  const includeParams = getIncludeParameterForEventTypes([event.type])
  if (includeParams.length === 0) return

  const eventResult = await listEvents({
    actor: `camera:${selectedCameraId.value}`,
    type__in: [event.type],
    startTimestamp__gte: formatTimestamp(event.startTimestamp),
    startTimestamp__lte: formatTimestamp(event.startTimestamp),
    include: includeParams,
    pageSize: 1
  })

  const enrichedEvent = eventResult.data?.results?.find((e: any) => e.id === event.id)
  if (!enrichedEvent) return

  const boxes = extractBoundingBoxes(enrichedEvent as unknown as SSEEvent)
  if (boxes.length === 0) return

  // Clear any existing timer
  if (videoBoxTimer) clearTimeout(videoBoxTimer)

  videoBoundingBoxes.value = boxes
  videoBoxTimer = setTimeout(() => {
    videoBoundingBoxes.value = []
    videoBoxTimer = null
  }, 250)
}

// Track component lifecycle
const isMounted = ref(true)

async function loadCameras() {
  loading.value = true
  error.value = null

  const result = await getCameras()

  if (!isMounted.value) return

  if (result.error) {
    error.value = result.error.message
    loading.value = false
    return
  }

  cameras.value = result.data?.results || []
  loading.value = false

  // Auto-select: prefer stored camera, fall back to first
  if (cameras.value.length > 0 && !selectedCameraId.value) {
    const storedId = localStorage.getItem(CAMERA_STORAGE_KEY)
    if (storedId && cameras.value.some(c => c.id === storedId)) {
      selectedCameraId.value = storedId
    } else {
      selectedCameraId.value = cameras.value[0].id
    }
  }
}

async function startStream(cameraId: string) {
  if (!cameraId) return

  // Clean up previous stream
  stopStream()

  if (isIOS) {
    streamError.value = 'Live HD video is not supported on iOS devices. The EEN Live Video SDK requires features not available in iOS browsers.'
    return
  }

  streamLoading.value = true
  streamError.value = null

  // Force a fresh video element by changing the key
  videoKey.value++
  await nextTick()

  if (!videoRef.value || !isMounted.value) {
    streamLoading.value = false
    streamError.value = 'Video element not available.'
    return
  }

  try {
    // CRITICAL: Create LivePlayer WITHOUT arguments
    livePlayer = new LivePlayer()

    // CRITICAL: Pass config to start(), NOT to constructor
    await livePlayer.start({
      videoElement: videoRef.value,
      cameraId,
      baseUrl: authStore.baseUrl ?? '',
      jwt: authStore.token ?? ''
    })

    if (isMounted.value) {
      streamLoading.value = false
    }
  } catch (err: any) {
    if (isMounted.value) {
      streamError.value = err?.message || 'Failed to start live video.'
      streamLoading.value = false
    }
  }
}

function stopStream() {
  if (livePlayer) {
    livePlayer.stop()
    livePlayer = null
  }
  streamError.value = null
}

const CAMERA_STORAGE_KEY = 'selectedCameraId'
const EVENT_TYPES_STORAGE_KEY = 'selectedEventTypes'

function handleCameraChange(event: Event) {
  const target = event.target as HTMLSelectElement
  selectedCameraId.value = target.value
  localStorage.setItem(CAMERA_STORAGE_KEY, target.value)
  localStorage.removeItem(EVENT_TYPES_STORAGE_KEY)
}

// SSE event feed functions

/** Clean up existing SSE subscription and connection */
async function cleanupSSE() {
  if (sseConnection) {
    sseConnection.close()
    sseConnection = null
  }
  if (currentSubscriptionId) {
    try {
      await deleteEventSubscription(currentSubscriptionId)
    } catch {
      // Ignore cleanup errors
    }
    currentSubscriptionId = null
  }
  sseStatus.value = 'disconnected'
}

/** Format event type for display (e.g., "een.motionDetectionEvent.v1" -> "Motion Detection") */
function formatEventType(type: string): string {
  const match = type.match(/een\.(\w+)Event\.v\d+/)
  if (match) {
    return match[1]
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim()
  }
  return type
}

/** Format timestamp for display */
function formatEventTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString()
}

/** Start SSE subscription for a camera */
async function startSSE(cameraId: string, skipDiscovery = false) {
  // Clean up previous subscription
  await cleanupSSE()

  sseEvents.value = []
  sseError.value = null
  sseLoading.value = true

  if (!skipDiscovery) {
    // Step 1: Discover available event types for this camera
    const fieldValuesResult = await listEventFieldValues({
      actor: `camera:${cameraId}`
    })

    if (!isMounted.value) {
      sseLoading.value = false
      return
    }

    if (fieldValuesResult.error) {
      sseError.value = `Failed to get event types: ${fieldValuesResult.error.message}`
      sseLoading.value = false
      return
    }

    const discovered: string[] = fieldValuesResult.data.type || []
    if (discovered.length === 0) {
      sseError.value = 'No event types available for this camera.'
      sseLoading.value = false
      return
    }

    availableEventTypes.value = discovered
    ignoreFilterWatch = true

    // Restore stored filter if camera matches
    const storedCamera = localStorage.getItem(CAMERA_STORAGE_KEY)
    const storedTypesJson = localStorage.getItem(EVENT_TYPES_STORAGE_KEY)
    let restoredTypes: string[] | null = null
    if (storedCamera === cameraId && storedTypesJson) {
      try {
        const parsed = JSON.parse(storedTypesJson)
        if (Array.isArray(parsed)) {
          restoredTypes = parsed.filter((t: string) => discovered.includes(t))
        }
      } catch { /* ignore */ }
    }

    selectedEventTypes.value = restoredTypes && restoredTypes.length > 0 ? restoredTypes : [...discovered]
    nextTick(() => { ignoreFilterWatch = false })
  }

  const typesToUse = selectedEventTypes.value
  if (typesToUse.length === 0) {
    sseError.value = 'No event types selected.'
    sseLoading.value = false
    return
  }

  // Step 2: Create SSE subscription for selected event types
  const subscriptionResult = await createEventSubscription({
    deliveryConfig: { type: 'serverSentEvents.v1' },
    filters: [{
      actors: [`camera:${cameraId}`],
      types: typesToUse.map(t => ({ id: t }))
    }]
  })

  if (!isMounted.value) {
    sseLoading.value = false
    return
  }

  if (subscriptionResult.error) {
    sseError.value = `Failed to create subscription: ${subscriptionResult.error.message}`
    sseLoading.value = false
    return
  }

  const subscription = subscriptionResult.data
  currentSubscriptionId = subscription.id

  const sseUrl = subscription.deliveryConfig.type === 'serverSentEvents.v1'
    ? subscription.deliveryConfig.sseUrl
    : undefined

  if (!sseUrl) {
    sseError.value = 'No SSE URL returned from subscription.'
    sseLoading.value = false
    return
  }

  // Step 3: Connect to SSE stream
  const connectionResult = connectToEventSubscription(sseUrl, {
    onEvent: (event: SSEEvent) => {
      if (!isMounted.value) return
      playEventSound()
      // Prepend new events (newest first), cap at MAX_SSE_EVENTS
      sseEvents.value = [event, ...sseEvents.value].slice(0, MAX_SSE_EVENTS)
      // Flash bounding boxes on live video for recent events
      flashVideoBoxes(event)
    },
    onError: (err: Error) => {
      if (!isMounted.value) return
      sseError.value = `SSE error: ${err.message}`
    },
    onStatusChange: (status: SSEConnectionStatus) => {
      if (!isMounted.value) return
      sseStatus.value = status
      if (status === 'connected') {
        sseLoading.value = false
        sseError.value = null
      }
    }
  })

  if (connectionResult.error) {
    sseError.value = `Failed to connect: ${connectionResult.error.message}`
    sseLoading.value = false
    return
  }

  sseConnection = connectionResult.data
  sseLoading.value = false

  // Step 4: Backfill with historical events from the last 24 hours
  const now = new Date()
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const historyInclude = getIncludeParameterForEventTypes(typesToUse)
  const historyResult = await listEvents({
    actor: `camera:${cameraId}`,
    type__in: typesToUse,
    startTimestamp__gte: oneDayAgo.toISOString(),
    startTimestamp__lte: now.toISOString(),
    sort: '-startTimestamp',
    pageSize: 100,
    ...(historyInclude.length > 0 ? { include: historyInclude } : {})
  })

  if (!isMounted.value) return

  if (historyResult.data?.results) {
    // Merge: keep existing SSE events on top, append historical ones, cap at MAX
    const existingIds = new Set(sseEvents.value.map(e => e.id))
    const newHistorical = historyResult.data.results.filter(e => !existingIds.has(e.id)) as unknown as SSEEvent[]
    sseEvents.value = [...sseEvents.value, ...newHistorical].slice(0, MAX_SSE_EVENTS)
  }
}

// Watch for camera selection changes
watch(selectedCameraId, (newId) => {
  if (newId && isAuthenticated.value) {
    availableEventTypes.value = []
    ignoreFilterWatch = true
    selectedEventTypes.value = []
    nextTick(() => { ignoreFilterWatch = false })
    eventFilterOpen.value = false
    startStream(newId)
    startSSE(newId)
  } else {
    stopStream()
    cleanupSSE()
    sseEvents.value = []
    availableEventTypes.value = []
    ignoreFilterWatch = true
    selectedEventTypes.value = []
    nextTick(() => { ignoreFilterWatch = false })
  }
})

// Flag to skip watcher when selectedEventTypes is set programmatically
let ignoreFilterWatch = false

// Watch for event type filter changes (user toggling checkboxes)
watch(selectedEventTypes, () => {
  if (ignoreFilterWatch) return
  localStorage.setItem(EVENT_TYPES_STORAGE_KEY, JSON.stringify(selectedEventTypes.value))
  if (selectedCameraId.value) {
    startSSE(selectedCameraId.value, true)
  }
}, { deep: true })

onMounted(() => {
  if (isAuthenticated.value) {
    loadCameras()
  }
})

onUnmounted(() => {
  isMounted.value = false
  stopStream()
  cleanupSSE()
  if (videoBoxTimer) clearTimeout(videoBoxTimer)
})
</script>

<template>
  <div class="home">
    <div v-if="!isAuthenticated" class="login-prompt">
      <p>Please <router-link to="/login">log in</router-link> to continue.</p>
    </div>

    <div v-else class="camera-content">
      <!-- Loading cameras -->
      <div v-if="loading" class="loading">Loading cameras...</div>

      <!-- Error loading cameras -->
      <div v-else-if="error && cameras.length === 0" class="error-state">
        <p class="error">{{ error }}</p>
        <button @click="loadCameras">Retry</button>
      </div>

      <!-- No cameras found -->
      <div v-else-if="cameras.length === 0" class="no-cameras">
        <p>No cameras found in your account.</p>
      </div>

      <!-- Camera selector and live video -->
      <div v-else class="camera-view">
        <div class="controls-row">
          <div class="camera-selector">
            <label for="camera-select">Camera:</label>
            <select
              id="camera-select"
              :value="selectedCameraId"
              @change="handleCameraChange"
            >
              <option v-for="camera in cameras" :key="camera.id" :value="camera.id">
                {{ camera.name || camera.id }}
              </option>
            </select>
          </div>
          <div v-if="availableEventTypes.length > 0" class="event-type-filter" @mouseleave="eventFilterOpen = false">
            <button class="filter-toggle" @click="eventFilterOpen = !eventFilterOpen">
              Event Types Selected: {{ selectedEventTypes.length }}/{{ availableEventTypes.length }}
              <span class="filter-arrow">{{ eventFilterOpen ? '\u25B2' : '\u25BC' }}</span>
            </button>
            <div v-if="eventFilterOpen" class="filter-dropdown">
              <div
                class="filter-toggle-all"
                @click="selectedEventTypes = selectedEventTypes.length === availableEventTypes.length ? [] : [...availableEventTypes]"
              >
                {{ selectedEventTypes.length === availableEventTypes.length ? 'Unselect All' : 'Select All' }}
              </div>
              <label v-for="type in availableEventTypes" :key="type" class="filter-option">
                <input type="checkbox" :value="type" v-model="selectedEventTypes" />
                {{ formatEventType(type) }}
              </label>
            </div>
          </div>
        </div>

        <!-- Stream error -->
        <div v-if="streamError" class="error-banner">
          <p class="error">{{ streamError }}</p>
        </div>

        <!-- Video + Event Feed row -->
        <div class="video-events-row">
          <!-- Live video display - video element always in DOM (required by SDK) -->
          <div class="stream-container">
            <div v-if="streamLoading" class="stream-loading">
              <p>Connecting to live HD video...</p>
            </div>
            <div class="video-wrapper" :class="{ hidden: streamLoading || !selectedCameraId }">
              <video :key="videoKey" ref="videoRef" autoplay muted playsinline />
              <div
                v-for="(box, i) in videoBoundingBoxes"
                :key="i"
                class="video-bounding-box"
                :style="{
                  left: box.x + '%',
                  top: box.y + '%',
                  width: box.width + '%',
                  height: box.height + '%'
                }"
              >
                <span v-if="box.label" class="video-box-label">{{ box.label }}</span>
              </div>
            </div>
          </div>

          <!-- SSE Event Feed -->
          <div class="event-feed">
          <div class="event-feed-header">
            <h3>Live Events</h3>
            <span
              class="sse-status"
              :class="{
                'status-connected': sseStatus === 'connected',
                'status-connecting': sseStatus === 'connecting',
                'status-disconnected': sseStatus === 'disconnected',
                'status-error': sseStatus === 'error'
              }"
            >{{ sseStatus }}</span>
          </div>

          <div v-if="sseLoading" class="event-feed-loading">
            Connecting to event stream...
          </div>

          <div v-if="sseError" class="event-feed-error">
            {{ sseError }}
          </div>

          <div v-if="!sseLoading && !sseError && sseEvents.length === 0 && sseStatus === 'connected'" class="event-feed-empty">
            Waiting for events...
          </div>

          <div v-if="sseEvents.length > 0" class="event-list">
            <div
              v-for="(event, index) in sseEvents"
              :key="`${event.id}-${index}`"
              class="event-item"
              @click="handleEventClick(event)"
            >
              <span class="event-type-badge">{{ formatEventType(event.type) }}</span>
              <span class="event-time">{{ formatEventTimestamp(event.startTimestamp) }}</span>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>

    <!-- Event Preview Modal -->
    <div v-if="modalOpen" class="modal-overlay" @click.self="closeModal">
      <div class="modal-content">
        <div class="modal-header">
          <span v-if="modalEvent" class="modal-title">
            {{ formatEventType(modalEvent.type) }} &mdash; {{ formatEventTimestamp(modalEvent.startTimestamp) }}
          </span>
          <button class="modal-close" @click="closeModal">&times;</button>
        </div>
        <div class="modal-body">
          <div v-if="modalLoading" class="modal-loading">Loading image...</div>
          <div v-else-if="modalImage" class="modal-image-container">
            <img :src="modalImage" alt="Event preview" class="modal-image" />
            <div
              v-for="(box, i) in modalBoundingBoxes"
              :key="i"
              class="bounding-box"
              :style="{
                left: box.x + '%',
                top: box.y + '%',
                width: box.width + '%',
                height: box.height + '%'
              }"
            >
              <span v-if="box.label" class="bounding-box-label">{{ box.label }}</span>
            </div>
          </div>
          <div v-else class="modal-no-image">No preview image available.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home {
  padding: 20px;
  font-family: sans-serif;
}

.login-prompt {
  text-align: center;
  padding: 40px;
}

.login-prompt a {
  color: #007bff;
  text-decoration: none;
}

.login-prompt a:hover {
  text-decoration: underline;
}

.camera-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.loading {
  text-align: center;
  padding: 40px;
  color: #666;
}

.error-state {
  text-align: center;
  padding: 20px;
}

.error {
  color: #dc3545;
  margin: 0 0 12px 0;
}

.error-banner {
  background-color: #fff3f3;
  border: 1px solid #dc3545;
  border-radius: 4px;
  padding: 12px;
}

.no-cameras {
  text-align: center;
  padding: 40px;
  color: #666;
}

.camera-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.camera-selector {
  display: flex;
  align-items: center;
  gap: 12px;
}

.camera-selector label {
  font-weight: 600;
  white-space: nowrap;
}

.camera-selector select {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 14px;
  background-color: white;
}

.controls-row {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
  align-items: start;
}

.event-type-filter {
  position: relative;
}

.filter-toggle {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 14px;
  background-color: white;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.filter-toggle:hover {
  border-color: #999;
}

.filter-arrow {
  font-size: 10px;
  margin-left: 8px;
}

.filter-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 10;
  background-color: white;
  border: 1px solid #ccc;
  border-top: none;
  border-radius: 0 0 4px 4px;
  max-height: 240px;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.filter-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}

.filter-option:hover {
  background-color: #f5f5f5;
}

.filter-option input[type="checkbox"] {
  margin: 0;
}

.filter-toggle-all {
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid #eee;
  color: #007bff;
}

.filter-toggle-all:hover {
  background-color: #f5f5f5;
}

.video-events-row {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
}

.stream-container {
  background-color: #000;
  border-radius: 4px;
  overflow: hidden;
  min-height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.stream-loading {
  color: #aaa;
  text-align: center;
  padding: 40px;
  position: absolute;
  z-index: 1;
}

.video-wrapper {
  width: 100%;
  position: relative;
}

.video-bounding-box {
  position: absolute;
  border: 2px solid #00ff00;
  box-sizing: border-box;
  pointer-events: none;
  z-index: 2;
}

.video-box-label {
  position: absolute;
  top: -18px;
  left: 0;
  background-color: rgba(0, 255, 0, 0.8);
  color: #000;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 2px;
  white-space: nowrap;
}

.video-wrapper.hidden {
  visibility: hidden;
  position: absolute;
}

.video-wrapper video {
  width: 100%;
  display: block;
}

/* Event Feed */
.event-feed {
  border: 1px solid #ddd;
  border-radius: 4px;
  overflow: hidden;
  min-width: 0;
  height: 0;
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.event-feed-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #ddd;
  background-color: #fafafa;
}

.event-feed-header h3 {
  margin: 0;
  font-size: 16px;
}

.sse-status {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 10px;
}

.status-connected {
  color: #155724;
  background-color: #d4edda;
}

.status-connecting {
  color: #856404;
  background-color: #fff3cd;
}

.status-disconnected {
  color: #666;
  background-color: #e9ecef;
}

.status-error {
  color: #721c24;
  background-color: #f8d7da;
}

.event-feed-loading,
.event-feed-empty {
  padding: 20px;
  text-align: center;
  color: #666;
  font-size: 14px;
}

.event-feed-error {
  padding: 12px 16px;
  color: #dc3545;
  background-color: #fff3f3;
  font-size: 13px;
}

.event-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #ccc #f5f5f5;
}

.event-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid #eee;
  font-size: 13px;
}

.event-item:last-child {
  border-bottom: none;
}

.event-type-badge {
  font-weight: 600;
  color: #333;
  white-space: nowrap;
}

.event-time {
  color: #666;
  margin-left: auto;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.event-item {
  cursor: pointer;
}

.event-item:hover {
  background-color: #f0f0f0;
}

@media (max-width: 768px) {
  .controls-row {
    grid-template-columns: 1fr;
  }
  .video-events-row {
    grid-template-columns: 1fr;
  }
  .event-feed {
    width: 100%;
    height: auto;
    min-height: 0;
  }
  .event-list {
    max-height: 165px;
    overflow-y: auto;
    flex: none;
  }
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background-color: #fff;
  border-radius: 8px;
  max-width: 720px;
  width: 90%;
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #ddd;
}

.modal-title {
  font-weight: 600;
  font-size: 14px;
}

.modal-close {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: #666;
  line-height: 1;
  padding: 0 4px;
}

.modal-close:hover {
  color: #333;
}

.modal-body {
  padding: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}

.modal-image-container {
  position: relative;
  width: 100%;
}

.modal-image {
  width: 100%;
  display: block;
  border-radius: 4px;
}

.bounding-box {
  position: absolute;
  border: 2px solid #00ff00;
  box-sizing: border-box;
  pointer-events: none;
}

.bounding-box-label {
  position: absolute;
  top: -20px;
  left: 0;
  background-color: rgba(0, 255, 0, 0.8);
  color: #000;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 2px;
  white-space: nowrap;
}

.modal-loading,
.modal-no-image {
  color: #666;
  font-size: 14px;
}

</style>

<style>
/* Dark mode overrides (unscoped so html[data-theme] selectors work) */
html[data-theme="dark"] .loading,
html[data-theme="dark"] .no-cameras {
  color: #999;
}
html[data-theme="dark"] .login-prompt a {
  color: #5b9df5;
}
html[data-theme="dark"] .camera-selector select {
  background-color: #2a2a2a;
  border-color: #555;
  color: #e0e0e0;
}
html[data-theme="dark"] .filter-toggle {
  background-color: #2a2a2a;
  border-color: #555;
  color: #e0e0e0;
}
html[data-theme="dark"] .filter-toggle:hover {
  border-color: #777;
}
html[data-theme="dark"] .filter-dropdown {
  background-color: #2a2a2a;
  border-color: #555;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
html[data-theme="dark"] .filter-option {
  color: #e0e0e0;
}
html[data-theme="dark"] .filter-option:hover {
  background-color: #333;
}
html[data-theme="dark"] .filter-toggle-all {
  color: #5b9df5;
  border-bottom-color: #444;
}
html[data-theme="dark"] .filter-toggle-all:hover {
  background-color: #333;
}
html[data-theme="dark"] .error-banner {
  background-color: #3a1a1a;
  border-color: #dc3545;
}
html[data-theme="dark"] .event-feed {
  border-color: #444;
}
html[data-theme="dark"] .event-feed-header {
  background-color: #2a2a2a;
  border-bottom-color: #444;
}
html[data-theme="dark"] .event-feed-loading,
html[data-theme="dark"] .event-feed-empty {
  color: #999;
}
html[data-theme="dark"] .event-feed-error {
  background-color: #3a1a1a;
}
html[data-theme="dark"] .event-item {
  border-bottom-color: #333;
}
html[data-theme="dark"] .event-type-badge {
  color: #e0e0e0;
}
html[data-theme="dark"] .event-time {
  color: #999;
}
html[data-theme="dark"] .status-connected {
  color: #a3d9a5;
  background-color: #1a3a1a;
}
html[data-theme="dark"] .status-connecting {
  color: #d9c77a;
  background-color: #3a3520;
}
html[data-theme="dark"] .status-disconnected {
  color: #999;
  background-color: #333;
}
html[data-theme="dark"] .status-error {
  color: #f5a5a5;
  background-color: #3a1a1a;
}
html[data-theme="dark"] .event-item:hover {
  background-color: #2a2a2a;
}
html[data-theme="dark"] .event-list {
  scrollbar-color: #555 #1a1a1a;
}
html[data-theme="dark"] .modal-content {
  background-color: #222;
}
html[data-theme="dark"] .modal-header {
  border-bottom-color: #444;
}
html[data-theme="dark"] .modal-close {
  color: #999;
}
html[data-theme="dark"] .modal-close:hover {
  color: #e0e0e0;
}
html[data-theme="dark"] .modal-loading,
html[data-theme="dark"] .modal-no-image {
  color: #999;
}

@media (prefers-color-scheme: dark) {
  html:not([data-theme]) .loading,
  html:not([data-theme]) .no-cameras {
    color: #999;
  }
  html:not([data-theme]) .login-prompt a {
    color: #5b9df5;
  }
  html:not([data-theme]) .camera-selector select {
    background-color: #2a2a2a;
    border-color: #555;
    color: #e0e0e0;
  }
  html:not([data-theme]) .filter-toggle {
    background-color: #2a2a2a;
    border-color: #555;
    color: #e0e0e0;
  }
  html:not([data-theme]) .filter-toggle:hover {
    border-color: #777;
  }
  html:not([data-theme]) .filter-dropdown {
    background-color: #2a2a2a;
    border-color: #555;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }
  html:not([data-theme]) .filter-option {
    color: #e0e0e0;
  }
  html:not([data-theme]) .filter-option:hover {
    background-color: #333;
  }
  html:not([data-theme]) .filter-toggle-all {
    color: #5b9df5;
    border-bottom-color: #444;
  }
  html:not([data-theme]) .filter-toggle-all:hover {
    background-color: #333;
  }
  html:not([data-theme]) .error-banner {
    background-color: #3a1a1a;
    border-color: #dc3545;
  }
  html:not([data-theme]) .event-feed {
    border-color: #444;
  }
  html:not([data-theme]) .event-feed-header {
    background-color: #2a2a2a;
    border-bottom-color: #444;
  }
  html:not([data-theme]) .event-feed-loading,
  html:not([data-theme]) .event-feed-empty {
    color: #999;
  }
  html:not([data-theme]) .event-feed-error {
    background-color: #3a1a1a;
  }
  html:not([data-theme]) .event-item {
    border-bottom-color: #333;
  }
  html:not([data-theme]) .event-type-badge {
    color: #e0e0e0;
  }
  html:not([data-theme]) .event-time {
    color: #999;
  }
  html:not([data-theme]) .status-connected {
    color: #a3d9a5;
    background-color: #1a3a1a;
  }
  html:not([data-theme]) .status-connecting {
    color: #d9c77a;
    background-color: #3a3520;
  }
  html:not([data-theme]) .status-disconnected {
    color: #999;
    background-color: #333;
  }
  html:not([data-theme]) .status-error {
    color: #f5a5a5;
    background-color: #3a1a1a;
  }
  html:not([data-theme]) .event-item:hover {
    background-color: #2a2a2a;
  }
  html:not([data-theme]) .event-list {
    scrollbar-color: #555 #1a1a1a;
  }
  html:not([data-theme]) .modal-content {
    background-color: #222;
  }
  html:not([data-theme]) .modal-header {
    border-bottom-color: #444;
  }
  html:not([data-theme]) .modal-close {
    color: #999;
  }
  html:not([data-theme]) .modal-close:hover {
    color: #e0e0e0;
  }
  html:not([data-theme]) .modal-loading,
  html:not([data-theme]) .modal-no-image {
    color: #999;
  }
}
</style>
