<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, inject, type Ref } from 'vue'
import {
  useAuthStore,
  getCameras,
  getRecordedImage,
  formatTimestamp,
  listEventFieldValues,
  createEventSubscription,
  connectToEventSubscription,
  deleteEventSubscription
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

// SSE event feed state
const sseEvents = ref<SSEEvent[]>([])
const sseStatus = ref<SSEConnectionStatus>('disconnected')
const sseError = ref<string | null>(null)
const sseLoading = ref(false)
let sseConnection: SSEConnection | null = null
let currentSubscriptionId: string | null = null
const MAX_SSE_EVENTS = 100
const soundEnabled = inject<Ref<boolean>>('soundEnabled', ref(true))

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

async function handleEventClick(event: SSEEvent) {
  modalEvent.value = event
  modalOpen.value = true
  modalLoading.value = true
  modalImage.value = null

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

  // Auto-select the first camera
  if (cameras.value.length > 0 && !selectedCameraId.value) {
    selectedCameraId.value = cameras.value[0].id
  }
}

async function startStream(cameraId: string) {
  if (!cameraId) return

  // Clean up previous stream
  stopStream()

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

function handleCameraChange(event: Event) {
  const target = event.target as HTMLSelectElement
  selectedCameraId.value = target.value
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
async function startSSE(cameraId: string) {
  // Clean up previous subscription
  await cleanupSSE()

  sseEvents.value = []
  sseError.value = null
  sseLoading.value = true

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

  const availableTypes: string[] = fieldValuesResult.data.type || []
  if (availableTypes.length === 0) {
    sseError.value = 'No event types available for this camera.'
    sseLoading.value = false
    return
  }

  // Step 2: Create SSE subscription for all available event types
  const subscriptionResult = await createEventSubscription({
    deliveryConfig: { type: 'serverSentEvents.v1' },
    filters: [{
      actors: [`camera:${cameraId}`],
      types: availableTypes.map(t => ({ id: t }))
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
}

// Watch for camera selection changes
watch(selectedCameraId, (newId) => {
  if (newId && isAuthenticated.value) {
    startStream(newId)
    startSSE(newId)
  } else {
    stopStream()
    cleanupSSE()
    sseEvents.value = []
  }
})

onMounted(() => {
  if (isAuthenticated.value) {
    loadCameras()
  }
})

onUnmounted(() => {
  isMounted.value = false
  stopStream()
  cleanupSSE()
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
          <img v-else-if="modalImage" :src="modalImage" alt="Event preview" class="modal-image" />
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

.modal-image {
  width: 100%;
  display: block;
  border-radius: 4px;
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
