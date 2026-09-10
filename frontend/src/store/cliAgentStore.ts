import { create } from 'zustand'

/** CLI 代理信息（由后端 cli-agents / cli-agent-available 事件下发） */
export interface CliAgentInfo {
  socketId: string
  proxyUrl: string
  agent?: string
  version?: string
}

interface CliAgentState {
  /** 本地 127.0.0.1:9333 健康检查是否在线 */
  localOnline: boolean
  /** 当前房间内已注册的 CLI 代理列表 */
  agents: CliAgentInfo[]
  /** 最近一次健康检查失败的原因（仅本地检测失败时） */
  localError: string | null
  /** 是否正在刷新代理列表 */
  isLoadingAgents: boolean
}

interface CliAgentActions {
  setLocalOnline: (online: boolean, error?: string | null) => void
  setAgents: (agents: CliAgentInfo[]) => void
  addAgent: (agent: CliAgentInfo) => void
  removeAgent: (socketId: string) => void
  setIsLoadingAgents: (loading: boolean) => void
  reset: () => void
}

const initialState: CliAgentState = {
  localOnline: false,
  agents: [],
  localError: null,
  isLoadingAgents: false,
}

export const useCliAgentStore = create<CliAgentState & CliAgentActions>(
  (set, get) => ({
    ...initialState,
    setLocalOnline: (online, error = null) =>
      set({ localOnline: online, localError: error }),
    setAgents: (agents) => {
      // 浅比较（长度 + socketId + 代理字段）：轮询拿回的列表与当前一致时
      // 不写 store，避免等价数据触发所有订阅者重渲染。
      const prev = get().agents
      const unchanged =
        prev.length === agents.length &&
        prev.every(
          (a, i) =>
            a.socketId === agents[i].socketId &&
            a.proxyUrl === agents[i].proxyUrl &&
            a.agent === agents[i].agent &&
            a.version === agents[i].version
        )
      if (unchanged) return
      set({ agents })
    },
    addAgent: (agent) =>
      set((state) => {
        const filtered = state.agents.filter(
          (a) => a.socketId !== agent.socketId
        )
        return { agents: [...filtered, agent] }
      }),
    removeAgent: (socketId) =>
      set((state) => ({
        agents: state.agents.filter((a) => a.socketId !== socketId),
      })),
    setIsLoadingAgents: (loading) => set({ isLoadingAgents: loading }),
    reset: () => set(initialState),
  })
)
