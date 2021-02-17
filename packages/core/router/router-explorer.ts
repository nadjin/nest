import { HttpServer } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { VersioningType } from '@nestjs/common/enums/version-type.enum';
import { InternalServerErrorException } from '@nestjs/common/exceptions';
import { Controller } from '@nestjs/common/interfaces/controllers/controller.interface';
import { Type } from '@nestjs/common/interfaces/type.interface';
import {
  VERSION_NEUTRAL,
  VersioningOptions,
  VersionValue,
} from '@nestjs/common/interfaces/version-options.interface';
import { Logger } from '@nestjs/common/services/logger.service';
import {
  addLeadingSlash,
  isString,
  isUndefined,
} from '@nestjs/common/utils/shared.utils';
import * as pathToRegexp from 'path-to-regexp';
import { ApplicationConfig } from '../application-config';
import { UnknownRequestMappingException } from '../errors/exceptions/unknown-request-mapping.exception';
import { GuardsConsumer } from '../guards/guards-consumer';
import { GuardsContextCreator } from '../guards/guards-context-creator';
import { ContextIdFactory } from '../helpers/context-id-factory';
import { ExecutionContextHost } from '../helpers/execution-context-host';
import {
  ROUTE_MAPPED_MESSAGE,
  VERSIONED_ROUTE_MAPPED_MESSAGE,
} from '../helpers/messages';
import { RouterMethodFactory } from '../helpers/router-method-factory';
import { STATIC_CONTEXT } from '../injector/constants';
import { NestContainer } from '../injector/container';
import { Injector } from '../injector/injector';
import { ContextId, InstanceWrapper } from '../injector/instance-wrapper';
import { Module } from '../injector/module';
import { InterceptorsConsumer } from '../interceptors/interceptors-consumer';
import { InterceptorsContextCreator } from '../interceptors/interceptors-context-creator';
import { MetadataScanner } from '../metadata-scanner';
import { PipesConsumer } from '../pipes/pipes-consumer';
import { PipesContextCreator } from '../pipes/pipes-context-creator';
import { ExceptionsFilter } from './interfaces/exceptions-filter.interface';
import { REQUEST_CONTEXT_ID } from './request/request-constants';
import { RouteParamsFactory } from './route-params-factory';
import { RouterExecutionContext } from './router-execution-context';
import { RouterProxy, RouterProxyCallback } from './router-proxy';

export interface RoutePathProperties {
  path: string[];
  requestMethod: RequestMethod;
  targetCallback: RouterProxyCallback;
  methodName: string;
  version?: VersionValue;
}

export class RouterExplorer {
  private readonly executionContextCreator: RouterExecutionContext;
  private readonly routerMethodFactory = new RouterMethodFactory();
  private readonly logger = new Logger(RouterExplorer.name, true);
  private readonly exceptionFiltersCache = new WeakMap();

  constructor(
    private readonly metadataScanner: MetadataScanner,
    private readonly container: NestContainer,
    private readonly injector?: Injector,
    private readonly routerProxy?: RouterProxy,
    private readonly exceptionsFilter?: ExceptionsFilter,
    config?: ApplicationConfig,
  ) {
    this.executionContextCreator = new RouterExecutionContext(
      new RouteParamsFactory(),
      new PipesContextCreator(container, config),
      new PipesConsumer(),
      new GuardsContextCreator(container, config),
      new GuardsConsumer(),
      new InterceptorsContextCreator(container, config),
      new InterceptorsConsumer(),
      container.getHttpAdapterRef(),
    );
  }

  public explore<T extends HttpServer = any>(
    instanceWrapper: InstanceWrapper,
    module: string,
    applicationRef: T,
    basePath: string,
    host: string | string[],
    versioningOptions?: VersioningOptions,
    controllerVersion?: VersionValue,
  ) {
    const { instance } = instanceWrapper;
    const routerPaths = this.scanForPaths(instance);
    this.applyPathsToRouterProxy(
      applicationRef,
      routerPaths,
      instanceWrapper,
      module,
      basePath,
      host,
      versioningOptions,
      controllerVersion,
    );
  }

  public extractRouterPath(metatype: Type<Controller>, prefix = ''): string[] {
    let path = Reflect.getMetadata(PATH_METADATA, metatype);

    if (isUndefined(path)) {
      throw new UnknownRequestMappingException();
    }

    if (Array.isArray(path)) {
      path = path.map(p => prefix + addLeadingSlash(p));
    } else {
      path = [prefix + addLeadingSlash(path)];
    }

    return path.map(p => addLeadingSlash(p));
  }

  public scanForPaths(
    instance: Controller,
    prototype?: object,
  ): RoutePathProperties[] {
    const instancePrototype = isUndefined(prototype)
      ? Object.getPrototypeOf(instance)
      : prototype;

    return this.metadataScanner.scanFromPrototype<
      Controller,
      RoutePathProperties
    >(instance, instancePrototype, method =>
      this.exploreMethodMetadata(instance, instancePrototype, method),
    );
  }

  public exploreMethodMetadata(
    instance: Controller,
    prototype: object,
    methodName: string,
  ): RoutePathProperties {
    const targetCallback = prototype[methodName];
    const routePath = Reflect.getMetadata(PATH_METADATA, targetCallback);
    if (isUndefined(routePath)) {
      return null;
    }
    const requestMethod: RequestMethod = Reflect.getMetadata(
      METHOD_METADATA,
      targetCallback,
    );
    const version: VersionValue | undefined = Reflect.getMetadata(
      VERSION_METADATA,
      targetCallback,
    );
    const path = isString(routePath)
      ? [addLeadingSlash(routePath)]
      : routePath.map(p => addLeadingSlash(p));
    return {
      path,
      requestMethod,
      targetCallback,
      methodName,
      version,
    };
  }

  public applyPathsToRouterProxy<T extends HttpServer>(
    router: T,
    routePaths: RoutePathProperties[],
    instanceWrapper: InstanceWrapper,
    moduleKey: string,
    basePath: string,
    host: string | string[],
    versioningOptions?: VersioningOptions,
    controllerVersion?: VersionValue,
  ) {
    (routePaths || []).forEach(pathProperties => {
      const { path, requestMethod, version: pathVersion } = pathProperties;
      // The version will be either the path version or the controller version,
      // with the pathVersion taking priority.
      const version = pathVersion || controllerVersion;
      this.applyCallbackToRouter(
        router,
        pathProperties,
        instanceWrapper,
        moduleKey,
        basePath,
        host,
        versioningOptions,
        version,
      );
      path.forEach(item => {
        const pathStr = this.stripEndSlash(basePath) + this.stripEndSlash(item);
        if (version && versioningOptions) {
          this.logger.log(
            VERSIONED_ROUTE_MAPPED_MESSAGE(pathStr, requestMethod, version),
          );
        } else {
          this.logger.log(ROUTE_MAPPED_MESSAGE(pathStr, requestMethod));
        }
      });
    });
  }

  public stripEndSlash(str: string) {
    return str[str.length - 1] === '/' ? str.slice(0, str.length - 1) : str;
  }

  private applyCallbackToRouter<T extends HttpServer>(
    router: T,
    pathProperties: RoutePathProperties,
    instanceWrapper: InstanceWrapper,
    moduleKey: string,
    basePath: string,
    host: string | string[],
    versioningOptions?: VersioningOptions,
    version?: VersionValue,
  ) {
    const {
      path: paths,
      requestMethod,
      targetCallback,
      methodName,
    } = pathProperties;
    const { instance } = instanceWrapper;
    const routerMethod = this.routerMethodFactory
      .get(router, requestMethod)
      .bind(router);

    const isRequestScoped = !instanceWrapper.isDependencyTreeStatic();
    const proxy = isRequestScoped
      ? this.createRequestScopedHandler(
          instanceWrapper,
          requestMethod,
          this.container.getModuleByKey(moduleKey),
          moduleKey,
          methodName,
        )
      : this.createCallbackProxy(
          instance,
          targetCallback,
          methodName,
          moduleKey,
          requestMethod,
        );

    let handler = this.applyHostFilter(host, proxy);
    paths.forEach(path => {
      if (version && versioningOptions) {
        // URI Versioning is done via adding the version into the URL
        if (versioningOptions.type === VersioningType.URI) {
          this.applyUriVersioningCallbacks(
            version,
            versioningOptions,
            basePath,
            path,
            handler,
            routerMethod,
          );
          return;
        }
        // All other versioning is done via the Version Filter
        handler = this.applyVersionFilter(version, versioningOptions, handler);
      }
      const fullPath = this.stripEndSlash(basePath) + path;
      routerMethod(this.stripEndSlash(fullPath) || '/', handler);
    });
  }

  private applyUriVersioningCallbacks(
    version: VersionValue,
    versioningOptions: VersioningOptions,
    basePath: string,
    path: string,
    handler: Function,
    routerMethod: Function,
  ) {
    // Determine Version Prefix (defaulting to 'v')
    let versionPrefix = 'v';
    if (versioningOptions.type === VersioningType.URI) {
      if (versioningOptions.prefix === false) {
        versionPrefix = '';
      } else if (versioningOptions.prefix !== undefined) {
        versionPrefix = versioningOptions.prefix;
      }
    }

    // Version Neutral - Do not include version in URL
    if (version === VERSION_NEUTRAL) {
      const unversionedPath = this.stripEndSlash(basePath) + path;
      routerMethod(this.stripEndSlash(unversionedPath), handler);
    }
    // Multiple Versions - Add routes for each version
    else if (Array.isArray(version)) {
      version.forEach(v => {
        const versionedPath =
          this.stripEndSlash(basePath) + `/${versionPrefix}${v}` + path;
        routerMethod(this.stripEndSlash(versionedPath), handler);
      });
    }
    // Single version
    else if (isString(version)) {
      const versionedPath =
        this.stripEndSlash(basePath) + `/${versionPrefix}${version}` + path;
      routerMethod(this.stripEndSlash(versionedPath), handler);
    }
  }

  private applyHostFilter(host: string | string[], handler: Function) {
    if (!host) {
      return handler;
    }

    const httpAdapterRef = this.container.getHttpAdapterRef();
    const hosts = Array.isArray(host) ? host : [host];
    const hostRegExps = hosts.map((host: string) => {
      const keys = [];
      const regexp = pathToRegexp(host, keys);
      return { regexp, keys };
    });

    const unsupportedFilteringErrorMessage = Array.isArray(host)
      ? `HTTP adapter does not support filtering on hosts: ["${host.join(
          '", "',
        )}"]`
      : `HTTP adapter does not support filtering on host: "${host}"`;

    return <TRequest extends Record<string, any> = any, TResponse = any>(
      req: TRequest,
      res: TResponse,
      next: () => void,
    ) => {
      (req as Record<string, any>).hosts = {};
      const hostname = httpAdapterRef.getRequestHostname(req) || '';

      for (const exp of hostRegExps) {
        const match = hostname.match(exp.regexp);
        if (match) {
          exp.keys.forEach((key, i) => (req.hosts[key.name] = match[i + 1]));
          return handler(req, res, next);
        }
      }
      if (!next) {
        throw new InternalServerErrorException(
          unsupportedFilteringErrorMessage,
        );
      }
      return next();
    };
  }

  private applyVersionFilter(
    version: VersionValue,
    versioningOptions: VersioningOptions,
    handler: Function,
  ) {
    return <TRequest extends Record<string, any> = any, TResponse = any>(
      req: TRequest,
      res: TResponse,
      next: () => void,
    ) => {
      // Version Neutral routes do not care about the version, so the filter continues forward
      if (version === VERSION_NEUTRAL) {
        return handler(req, res, next);
      }

      // URL Versioning is done via the path, so the filter continues forward
      if (versioningOptions.type === VersioningType.URI) {
        return handler(req, res, next);
      }

      // Media Type (Accept Header) Versioning Handler
      if (versioningOptions.type === VersioningType.MEDIA_TYPE) {
        const MEDIA_TYPE_HEADER = 'Accept';
        const acceptHeaderValue: string | undefined =
          req.headers[MEDIA_TYPE_HEADER] ||
          req.headers[MEDIA_TYPE_HEADER.toLowerCase()];
        const acceptHeaderVersionParameter = acceptHeaderValue
          ? acceptHeaderValue.split(';')[1]
          : '';

        if (acceptHeaderVersionParameter) {
          const headerVersion = acceptHeaderVersionParameter.split(
            versioningOptions.key,
          )[1];
          if (Array.isArray(version)) {
            if (version.includes(headerVersion)) {
              return handler(req, res, next);
            }
          } else if (isString(version)) {
            if (version === headerVersion) {
              return handler(req, res, next);
            }
          }
        }
      }
      // Header Versioning Handler
      else if (versioningOptions.type === VersioningType.HEADER) {
        const customHeaderVersionParameter: string | undefined =
          req.headers[versioningOptions.header] ||
          req.headers[versioningOptions.header.toLowerCase()];

        if (customHeaderVersionParameter) {
          if (Array.isArray(version)) {
            if (version.includes(customHeaderVersionParameter)) {
              return handler(req, res, next);
            }
          } else if (isString(version)) {
            if (version === customHeaderVersionParameter) {
              return handler(req, res, next);
            }
          }
        }
      }

      if (!next) {
        throw new InternalServerErrorException(
          'HTTP adapter does not support filtering on version',
        );
      }
      return next();
    };
  }

  private createCallbackProxy(
    instance: Controller,
    callback: RouterProxyCallback,
    methodName: string,
    moduleRef: string,
    requestMethod: RequestMethod,
    contextId = STATIC_CONTEXT,
    inquirerId?: string,
  ) {
    const executionContext = this.executionContextCreator.create(
      instance,
      callback,
      methodName,
      moduleRef,
      requestMethod,
      contextId,
      inquirerId,
    );
    const exceptionFilter = this.exceptionsFilter.create(
      instance,
      callback,
      moduleRef,
      contextId,
      inquirerId,
    );
    return this.routerProxy.createProxy(executionContext, exceptionFilter);
  }

  public createRequestScopedHandler(
    instanceWrapper: InstanceWrapper,
    requestMethod: RequestMethod,
    moduleRef: Module,
    moduleKey: string,
    methodName: string,
  ) {
    const { instance } = instanceWrapper;
    const collection = moduleRef.controllers;
    return async <TRequest extends Record<any, any>, TResponse>(
      req: TRequest,
      res: TResponse,
      next: () => void,
    ) => {
      try {
        const contextId = this.getContextId(req);
        const contextInstance = await this.injector.loadPerContext(
          instance,
          moduleRef,
          collection,
          contextId,
        );
        await this.createCallbackProxy(
          contextInstance,
          contextInstance[methodName],
          methodName,
          moduleKey,
          requestMethod,
          contextId,
          instanceWrapper.id,
        )(req, res, next);
      } catch (err) {
        let exceptionFilter = this.exceptionFiltersCache.get(
          instance[methodName],
        );
        if (!exceptionFilter) {
          exceptionFilter = this.exceptionsFilter.create(
            instance,
            instance[methodName],
            moduleKey,
          );
          this.exceptionFiltersCache.set(instance[methodName], exceptionFilter);
        }
        const host = new ExecutionContextHost([req, res, next]);
        exceptionFilter.next(err, host);
      }
    };
  }

  private getContextId<T extends Record<any, unknown> = any>(
    request: T,
  ): ContextId {
    const contextId = ContextIdFactory.getByRequest(request);
    if (!request[REQUEST_CONTEXT_ID as any]) {
      Object.defineProperty(request, REQUEST_CONTEXT_ID, {
        value: contextId,
        enumerable: false,
        writable: false,
        configurable: false,
      });
      this.container.registerRequestProvider(request, contextId);
    }
    return contextId;
  }
}
