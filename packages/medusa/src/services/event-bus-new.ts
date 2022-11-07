import Bull from "bull"
import Redis from "ioredis"
import { EntityManager } from "typeorm"
import { StagedJob } from "../models"
import { StagedJobRepository } from "../repositories/staged-job"
import { ConfigModule, Logger, MedusaContainer } from "../types/global"
import { sleep } from "../utils/sleep"

type InjectedDependencies = {
  manager: EntityManager
  logger: Logger
  stagedJobRepository: typeof StagedJobRepository
  redisClient: Redis.Redis
  redisSubscriber: Redis.Redis
  eventBusStrategy: IEventBusStrategy
}

type EventHandler<T = unknown> = (data: T, eventName: string) => Promise<void>

type RedisCreateConnectionOptions = {
  client: Redis.Redis
  subscriber: Redis.Redis
}

interface IEventBusStrategy {
  publish<T>(eventName: string, data: T, options: Record<string, unknown>): void
  subscribe<T>(eventName: string, handler: (data: T) => void): void
}

/**
 * Can keep track of multiple subscribers to different events and run the
 * subscribers when events happen. Events will run asynchronously.
 */
export default class EventBusService {
  protected readonly container_: MedusaContainer & InjectedDependencies
  protected readonly config_: ConfigModule
  protected readonly manager_: EntityManager
  protected readonly logger_: Logger
  protected readonly stagedJobRepository_: typeof StagedJobRepository
  protected readonly eventBusStrategy_: IEventBusStrategy

  protected observers_: Map<string | symbol, EventHandler[]>
  protected cronHandlers_: Map<string | symbol, EventHandler[]>
  //   protected cronQueue_: Bull
  //   protected queue_: Bull
  protected shouldEnqueuerRun: boolean
  protected transactionManager_: EntityManager | undefined
  protected enqueue_: Promise<void>

  constructor(
    container: MedusaContainer & InjectedDependencies,
    config: ConfigModule,
    singleton = true
  ) {
    this.container_ = container
    this.config_ = config
    this.manager_ = container.manager
    this.logger_ = container.logger
    this.eventBusStrategy_ = container.eventBusStrategy
    this.stagedJobRepository_ = container.stagedJobRepository
  }

  connect(options: RedisCreateConnectionOptions): void {
    const { client, subscriber } = options

    this.observers_ = new Map()
    this.queue_ = new Bull(
      `${this.constructor.name}:queue`,
      this.reuseConnections(client, subscriber)
    )
    this.cronHandlers_ = new Map()
    this.redisClient_ = client
    this.redisSubscriber_ = subscriber
    this.cronQueue_ = new Bull(
      `cron-jobs:queue`,
      this.reuseConnections(client, subscriber)
    )
    // Register our worker to handle emit calls
    this.queue_.process(this.worker_)
    // Register cron worker
    this.cronQueue_.process(this.cronWorker_)

    if (process.env.NODE_ENV !== "test") {
      this.startEnqueuer()
    }
  }

  withTransaction(transactionManager): this | EventBusService {
    if (!transactionManager) {
      return this
    }

    const cloned = new EventBusService(
      {
        ...this.container_,
        manager: transactionManager,
        stagedJobRepository: this.stagedJobRepository_,
        logger: this.logger_,
        redisClient: this.redisClient_,
        redisSubscriber: this.redisSubscriber_,
      },
      this.config_,
      false
    )

    cloned.transactionManager_ = transactionManager
    cloned.queue_ = this.queue_

    return cloned
  }

  /**
   * Adds a function to a list of event subscribers.
   * @param event - the event that the subscriber will listen for.
   * @param subscriber - the function to be called when a certain event
   * happens. Subscribers must return a Promise.
   * @return this
   */
  subscribe(event: string | symbol, handler: EventHandler): this {
    if (typeof handler !== "function") {
      throw new Error("Subscriber must be a function")
    }

    const observers = this.observers_.get(event) ?? []
    this.observers_.set(event, [...observers, handler])

    return this
  }

  /**
   * Adds a function to a list of event subscribers.
   * @param event - the event that the subscriber will listen for.
   * @param subscriber - the function to be called when a certain event
   * happens. Subscribers must return a Promise.
   * @return this
   */
  unsubscribe(event: string | symbol, subscriber: EventHandler): this {
    if (typeof subscriber !== "function") {
      throw new Error("Subscriber must be a function")
    }

    if (this.observers_.get(event)?.length) {
      const index = this.observers_.get(event)?.indexOf(subscriber)
      if (index !== -1) {
        this.observers_.get(event)?.splice(index as number, 1)
      }
    }

    return this
  }

  /**
   * Adds a function to a list of event subscribers.
   * @param event - the event that the subscriber will listen for.
   * @param subscriber - the function to be called when a certain event
   * happens. Subscribers must return a Promise.
   * @return this
   */
  protected registerCronHandler_(
    event: string | symbol,
    subscriber: EventHandler
  ): this {
    if (typeof subscriber !== "function") {
      throw new Error("Handler must be a function")
    }

    const cronHandlers = this.cronHandlers_.get(event) ?? []
    this.cronHandlers_.set(event, [...cronHandlers, subscriber])

    return this
  }

  /**
   * Calls all subscribers when an event occurs.
   * @param {string} eventName - the name of the event to be process.
   * @param data - the data to send to the subscriber.
   * @param options - options to add the job with
   * @return the job from our queue
   */
  async emit<T>(
    eventName: string,
    data: T,
    options: { delay?: number } = {}
  ): Promise<StagedJob | void> {
    if (this.transactionManager_) {
      const stagedJobRepository = this.transactionManager_.getCustomRepository(
        this.stagedJobRepository_
      )

      const stagedJobInstance = stagedJobRepository.create({
        event_name: eventName,
        data,
      } as StagedJob)

      return await stagedJobRepository.save(stagedJobInstance)
    } else {
      // should be replaced by a generic event bus
      const opts: { removeOnComplete: boolean; delay?: number } = {
        removeOnComplete: true,
      }
      if (typeof options.delay === "number") {
        opts.delay = options.delay
      }
      this.queue_.add({ eventName, data }, opts)
    }
  }

  startEnqueuer(): void {
    this.shouldEnqueuerRun = true
    this.enqueue_ = this.enqueuer_()
  }

  async stopEnqueuer(): Promise<void> {
    this.shouldEnqueuerRun = false
    await this.enqueue_
  }

  async enqueuer_(): Promise<void> {
    while (this.shouldEnqueuerRun) {
      const listConfig = {
        relations: [],
        skip: 0,
        take: 1000,
      }

      const stagedJobRepo = this.manager_.getCustomRepository(
        this.stagedJobRepository_
      )
      const jobs = await stagedJobRepo.find(listConfig)

      await Promise.all(
        jobs.map((job) => {
          this.queue_
            .add(
              { eventName: job.event_name, data: job.data },
              { removeOnComplete: true }
            )
            .then(async () => {
              await stagedJobRepo.remove(job)
            })
        })
      )

      await sleep(3000)
    }
  }

  /**
   * Handles incoming jobs.
   * @param job The job object
   * @return resolves to the results of the subscriber calls.
   */
  worker_ = async <T>(job: {
    data: { eventName: string; data: T }
  }): Promise<unknown[]> => {
    const { eventName, data } = job.data
    const eventObservers = this.observers_.get(eventName) || []
    const wildcardObservers = this.observers_.get("*") || []

    const observers = eventObservers.concat(wildcardObservers)

    this.logger_.info(
      `Processing ${eventName} which has ${eventObservers.length} subscribers`
    )

    return await Promise.all(
      observers.map(async (subscriber) => {
        return subscriber(data, eventName).catch((err) => {
          this.logger_.warn(
            `An error occurred while processing ${eventName}: ${err}`
          )
          console.error(err)
          return err
        })
      })
    )
  }

  /**
   * Handles incoming jobs.
   * @param job The job object
   * @return resolves to the results of the subscriber calls.
   */
  cronWorker_ = async <T>(job: {
    data: { eventName: string; data: T }
  }): Promise<unknown[]> => {
    const { eventName, data } = job.data
    const observers = this.cronHandlers_.get(eventName) || []
    this.logger_.info(`Processing cron job: ${eventName}`)

    return await Promise.all(
      observers.map(async (subscriber) => {
        return subscriber(data, eventName).catch((err) => {
          this.logger_.warn(
            `An error occured while processing ${eventName}: ${err}`
          )
          return err
        })
      })
    )
  }

  /**
   * Registers a cron job.
   * @param eventName - the name of the event
   * @param data - the data to be sent with the event
   * @param cron - the cron pattern
   * @param handler - the handler to call on each cron job
   * @return void
   */
  createCronJob<T>(
    eventName: string,
    data: T,
    cron: string,
    handler: EventHandler
  ): void {
    this.logger_.info(`Registering ${eventName}`)
    this.registerCronHandler_(eventName, handler)
    return this.cronQueue_.add(
      {
        eventName,
        data,
      },
      { repeat: { cron } }
    )
  }
}