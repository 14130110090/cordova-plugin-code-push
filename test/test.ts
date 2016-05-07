/// <reference path="../typings/assert.d.ts" />
/// <reference path="../typings/codePush.d.ts" />
/// <reference path="../typings/code-push-plugin-testing-framework.d.ts" />
/// <reference path="../typings/mocha.d.ts" />
/// <reference path="../typings/mkdirp.d.ts" />
/// <reference path="../typings/node.d.ts" />
/// <reference path="../typings/q.d.ts" />

"use strict";

import assert = require("assert");
import fs = require("fs");
import mkdirp = require("mkdirp");
import path = require("path");

import { Platform, PluginTestingFramework, ProjectManager, ServerUtil } from "code-push-plugin-testing-framework";

import Q = require("q");

var del = require("del");
var archiver = require("archiver");

// Create the ProjectManager to use for the tests.
class CordovaProjectManager extends ProjectManager {
    public static AcquisitionSDKPluginName = "code-push";
    public static WkWebViewEnginePluginName = "cordova-plugin-wkwebview-engine";
    
    /**
     * Returns the name of the plugin being tested, ie Cordova or React-Native
     */
    public getPluginName(): string {
        return "Cordova";
    }

	/**
	 * Creates a new test application at the specified path, and configures it
	 * with the given server URL, android and ios deployment keys.
	 */
    public setupProject(projectDirectory: string, templatePath: string, appName: string, appNamespace: string, version?: string): Q.Promise<string> {
        if (fs.existsSync(projectDirectory)) {
            del.sync([projectDirectory], { force: true });
        }
        mkdirp.sync(projectDirectory);
        
        var indexHtml = "www/index.html";
        var destinationIndexPath = path.join(projectDirectory, indexHtml);

        return ProjectManager.execChildProcess("cordova create " + projectDirectory + " " + appNamespace + " " + appName + " --copy-from " + templatePath)
            .then<string>(ProjectManager.replaceString.bind(undefined, destinationIndexPath, ProjectManager.CODE_PUSH_APP_VERSION_PLACEHOLDER, version))
            .then<string>(this.addCordovaPlugin.bind(this, projectDirectory, CordovaProjectManager.AcquisitionSDKPluginName))
            .then<string>(this.addCordovaPlugin.bind(this, projectDirectory, PluginTestingFramework.thisPluginPath));
    }
    
    /**
     * Sets up the scenario for a test in an already existing project.
     */
    public setupScenario(projectDirectory: string, appId: string, templatePath: string, jsPath: string, targetPlatform: Platform.IPlatform, version?: string): Q.Promise<string> {
        var indexHtml = "www/index.html";
        var templateIndexPath = path.join(templatePath, indexHtml);
        var destinationIndexPath = path.join(projectDirectory, indexHtml);
        
        var scenarioJs = "www/" + jsPath;
        var templateScenarioJsPath = path.join(templatePath, scenarioJs);
        var destinationScenarioJsPath = path.join(projectDirectory, scenarioJs);
        
        var configXml = "config.xml";
        var templateConfigXmlPath = path.join(templatePath, configXml);
        var destinationConfigXmlPath = path.join(projectDirectory, configXml);
        
        var packageFile = eval("(" + fs.readFileSync("./package.json", "utf8") + ")");
        var pluginVersion = packageFile.version;
        
        console.log("Setting up scenario " + jsPath + " in " + projectDirectory);

        // copy index html file and replace
        return ProjectManager.copyFile(templateIndexPath, destinationIndexPath, true)
            .then<void>(ProjectManager.replaceString.bind(undefined, destinationIndexPath, ProjectManager.SERVER_URL_PLACEHOLDER, targetPlatform.getServerUrl()))
            .then<void>(ProjectManager.replaceString.bind(undefined, destinationIndexPath, ProjectManager.INDEX_JS_PLACEHOLDER, jsPath))
            .then<void>(ProjectManager.replaceString.bind(undefined, destinationIndexPath, ProjectManager.CODE_PUSH_APP_VERSION_PLACEHOLDER, version))
            // copy scenario js file and replace
            .then<void>(() => {
                return ProjectManager.copyFile(templateScenarioJsPath, destinationScenarioJsPath, true);
            })
            .then<void>(ProjectManager.replaceString.bind(undefined, destinationScenarioJsPath, ProjectManager.SERVER_URL_PLACEHOLDER, targetPlatform.getServerUrl()))
            // copy config xml file and replace
            .then<void>(() => {
                return ProjectManager.copyFile(templateConfigXmlPath, destinationConfigXmlPath, true);
            })
            .then<string>(ProjectManager.replaceString.bind(undefined, destinationConfigXmlPath, ProjectManager.ANDROID_KEY_PLACEHOLDER, Platform.Android.getInstance().getDefaultDeploymentKey()))
            .then<string>(ProjectManager.replaceString.bind(undefined, destinationConfigXmlPath, ProjectManager.IOS_KEY_PLACEHOLDER, Platform.IOS.getInstance().getDefaultDeploymentKey()))
            .then<string>(ProjectManager.replaceString.bind(undefined, destinationConfigXmlPath, ProjectManager.SERVER_URL_PLACEHOLDER, targetPlatform.getServerUrl()))
            .then<string>(ProjectManager.replaceString.bind(undefined, destinationConfigXmlPath, ProjectManager.PLUGIN_VERSION_PLACEHOLDER, pluginVersion))
            .then<string>(this.prepareCordovaPlatform.bind(this, projectDirectory, targetPlatform));
    }

    /**
     * Creates a CodePush update package zip for a project.
     */
    public createUpdateArchive(projectDirectory: string, targetPlatform: Platform.IPlatform, isDiff?: boolean): Q.Promise<string> {
        var deferred = Q.defer<string>();
        var archive = archiver.create("zip", {});
        var archivePath = path.join(projectDirectory, "update.zip");
        
        console.log("Creating an update archive at: " + archivePath);

        if (fs.existsSync(archivePath)) {
            fs.unlinkSync(archivePath);
        }
        var writeStream = fs.createWriteStream(archivePath);
        var targetFolder = targetPlatform.getPlatformWwwPath(projectDirectory);

        writeStream.on("close", function() {
            deferred.resolve(archivePath);
        });

        archive.on("error", function(e: Error) {
            deferred.reject(e);
        });

        if (isDiff) {
            archive.append(`{"deletedFiles":[]}`, { name: "hotcodepush.json" });
        }
        
        archive.directory(targetFolder, "www");
        archive.pipe(writeStream);
        archive.finalize();

        return deferred.promise;
    }
    
    /**
     * Prepares a specific platform for tests.
     */
    public preparePlatform(projectFolder: string, targetPlatform: Platform.IPlatform): Q.Promise<string> {
        return this.addCordovaPlatform(projectFolder, targetPlatform);
    }
    
    /**
     * Cleans up a specific platform after tests.
     */
    public cleanupAfterPlatform(projectFolder: string, targetPlatform: Platform.IPlatform): Q.Promise<string> {
        return this.removeCordovaPlatform(projectFolder, targetPlatform);
    }

    /**
     * Runs the test app on the given target / platform.
     */
    public runPlatform(projectFolder: string, targetPlatform: Platform.IPlatform): Q.Promise<string> {
        console.log("Running project in " + projectFolder + " on " + targetPlatform.getName());
        // Don't log the build output because iOS's build output is too verbose and overflows the buffer!
        return ProjectManager.execChildProcess("cordova run " + targetPlatform.getName(), { cwd: projectFolder }, false);
    }

    /**
     * Prepares the Cordova project for the test app on the given target / platform.
     */
    public prepareCordovaPlatform(projectFolder: string, targetPlatform: Platform.IPlatform): Q.Promise<string> {
        console.log("Preparing project in " + projectFolder + " for " + targetPlatform.getName());
        return ProjectManager.execChildProcess("cordova prepare " + targetPlatform.getName(), { cwd: projectFolder });
    }

    /**
     * Adds a platform to a Cordova project. 
     */
    public addCordovaPlatform(projectFolder: string, targetPlatform: Platform.IPlatform, version?: string): Q.Promise<string> {
        console.log("Adding " + targetPlatform.getName() + " to project in " + projectFolder);
        return ProjectManager.execChildProcess("cordova platform add " + targetPlatform.getName() + (version ? "@" + version : ""), { cwd: projectFolder });
    }

    /**
     * Adds a platform to a Cordova project. 
     */
    public removeCordovaPlatform(projectFolder: string, targetPlatform: Platform.IPlatform, version?: string): Q.Promise<string> {
        console.log("Adding " + targetPlatform.getName() + " to project in " + projectFolder);
        return ProjectManager.execChildProcess("cordova platform remove " + targetPlatform.getName() + (version ? "@" + version : ""), { cwd: projectFolder });
    }
    
    /**
     * Adds a plugin to a Cordova project.
     */
    public addCordovaPlugin(projectFolder: string, plugin: string): Q.Promise<string> {
        console.log("Adding plugin " + plugin + " to " + projectFolder);
        return ProjectManager.execChildProcess("cordova plugin add " + plugin, { cwd: projectFolder });
    }  
    
    /**
     * Removes a plugin from a Cordova project.
     */
    public removeCordovaPlugin(projectFolder: string, plugin: string): Q.Promise<string> {
        console.log("Removing plugin " + plugin + " from " + projectFolder);
        return ProjectManager.execChildProcess("cordova plugin remove " + plugin, { cwd: projectFolder });
    }
};

// Scenarios used in the tests.
const ScenarioCheckForUpdatePath = "js/scenarioCheckForUpdate.js";
const ScenarioCheckForUpdateCustomKey = "js/scenarioCheckForUpdateCustomKey.js";
const ScenarioDownloadUpdate = "js/scenarioDownloadUpdate.js";
const ScenarioInstall = "js/scenarioInstall.js";
const ScenarioInstallOnResumeWithRevert = "js/scenarioInstallOnResumeWithRevert.js";
const ScenarioInstallOnRestartWithRevert = "js/scenarioInstallOnRestartWithRevert.js";
const ScenarioInstallWithRevert = "js/scenarioInstallWithRevert.js";
const ScenarioSync1x = "js/scenarioSync.js";
const ScenarioSyncResume = "js/scenarioSyncResume.js";
const ScenarioSyncResumeDelay = "js/scenarioSyncResumeDelay.js";
const ScenarioSyncRestartDelay = "js/scenarioSyncResumeDelay.js";
const ScenarioSync2x = "js/scenarioSync2x.js";
const ScenarioRestart = "js/scenarioRestart.js";
const ScenarioSyncMandatoryDefault = "js/scenarioSyncMandatoryDefault.js";
const ScenarioSyncMandatoryResume = "js/scenarioSyncMandatoryResume.js";
const ScenarioSyncMandatoryRestart = "js/scenarioSyncMandatoryRestart.js";

const UpdateDeviceReady = "js/updateDeviceReady.js";
const UpdateNotifyApplicationReady = "js/updateNotifyApplicationReady.js";
const UpdateSync = "js/updateSync.js";
const UpdateSync2x = "js/updateSync2x.js";
const UpdateNotifyApplicationReadyConditional = "js/updateNARConditional.js";

// Describe the tests.
var testBuilderDescribes: PluginTestingFramework.TestBuilderDescribe[] = [
    
    new PluginTestingFramework.TestBuilderDescribe("#window.codePush.checkForUpdate",
    
        [
            new PluginTestingFramework.TestBuilderIt("window.codePush.checkForUpdate.noUpdate",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    var noUpdateResponse = PluginTestingFramework.createDefaultResponse();
                    noUpdateResponse.isAvailable = false;
                    noUpdateResponse.appVersion = "0.0.1";
                    PluginTestingFramework.updateResponse = { updateInfo: noUpdateResponse };

                    PluginTestingFramework.testMessageCallback = (requestBody: any) => {
                        try {
                            assert.equal(ServerUtil.TestMessage.CHECK_UP_TO_DATE, requestBody.message);
                            done();
                        } catch (e) {
                            done(e);
                        }
                    };

                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                },
                false),
            
            new PluginTestingFramework.TestBuilderIt("window.codePush.checkForUpdate.sendsBinaryHash",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    var noUpdateResponse = PluginTestingFramework.createDefaultResponse();
                        noUpdateResponse.isAvailable = false;
                        noUpdateResponse.appVersion = "0.0.1";

                        PluginTestingFramework.updateCheckCallback = (request: any) => {
                            try {
                                assert(request.query.packageHash);
                            } catch (e) {
                                done(e);
                            }
                        };
                        
                        PluginTestingFramework.updateResponse = { updateInfo: noUpdateResponse };

                        PluginTestingFramework.testMessageCallback = (requestBody: any) => {
                            try {
                                assert.equal(ServerUtil.TestMessage.CHECK_UP_TO_DATE, requestBody.message);
                                done();
                            } catch (e) {
                                done(e);
                            }
                        };

                        projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                }, false),
            
            new PluginTestingFramework.TestBuilderIt("window.codePush.checkForUpdate.noUpdate.updateAppVersion", 
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    var updateAppVersionResponse = PluginTestingFramework.createDefaultResponse();
                    updateAppVersionResponse.updateAppVersion = true;
                    updateAppVersionResponse.appVersion = "2.0.0";

                    PluginTestingFramework.updateResponse = { updateInfo: updateAppVersionResponse };

                    PluginTestingFramework.testMessageCallback = (requestBody: any) => {
                        try {
                            assert.equal(ServerUtil.TestMessage.CHECK_UP_TO_DATE, requestBody.message);
                            done();
                        } catch (e) {
                            done(e);
                        }
                    };

                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                }, false),
            
            new PluginTestingFramework.TestBuilderIt("window.codePush.checkForUpdate.update", 
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    var updateResponse = PluginTestingFramework.createMockResponse();
                    PluginTestingFramework.updateResponse = { updateInfo: updateResponse };

                    PluginTestingFramework.testMessageCallback = (requestBody: any) => {
                        try {
                            assert.equal(ServerUtil.TestMessage.CHECK_UPDATE_AVAILABLE, requestBody.message);
                            assert.notEqual(null, requestBody.args[0]);
                            var remotePackage: IRemotePackage = requestBody.args[0];
                            assert.equal(remotePackage.downloadUrl, updateResponse.downloadURL);
                            assert.equal(remotePackage.isMandatory, updateResponse.isMandatory);
                            assert.equal(remotePackage.label, updateResponse.label);
                            assert.equal(remotePackage.packageHash, updateResponse.packageHash);
                            assert.equal(remotePackage.packageSize, updateResponse.packageSize);
                            assert.equal(remotePackage.deploymentKey, targetPlatform.getDefaultDeploymentKey());
                            done();
                        } catch (e) {
                            done(e);
                        }
                    };

                    PluginTestingFramework.updateCheckCallback = (request: any) => {
                        try {
                            assert.notEqual(null, request);
                            assert.equal(request.query.deploymentKey, targetPlatform.getDefaultDeploymentKey());
                        } catch (e) {
                            done(e);
                        }
                    };

                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                }, true),
            
            new PluginTestingFramework.TestBuilderIt("window.codePush.checkForUpdate.error", 
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = "invalid {{ json";

                    PluginTestingFramework.testMessageCallback = (requestBody: any) => {
                        try {
                            assert.equal(ServerUtil.TestMessage.CHECK_ERROR, requestBody.message);
                            done();
                        } catch (e) {
                            done(e);
                        }
                    };

                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                }, false)
        ], ScenarioCheckForUpdatePath),
    
    new PluginTestingFramework.TestBuilderDescribe("#window.codePush.checkForUpdate.customKey",
        
        [new PluginTestingFramework.TestBuilderIt("window.codePush.checkForUpdate.customKey.update",
            (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                var updateResponse = PluginTestingFramework.createMockResponse();
                PluginTestingFramework.updateResponse = { updateInfo: updateResponse };

                PluginTestingFramework.updateCheckCallback = (request: any) => {
                    try {
                        assert.notEqual(null, request);
                        assert.equal(request.query.deploymentKey, "CUSTOM-DEPLOYMENT-KEY");
                        done();
                    } catch (e) {
                        done(e);
                    }
                };

                projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
            }, false)],
        ScenarioCheckForUpdateCustomKey),
        
    new PluginTestingFramework.TestBuilderDescribe("#remotePackage.download",
        
        [
            new PluginTestingFramework.TestBuilderIt("remotePackage.download.success",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    /* pass the path to any file for download (here, config.xml) to make sure the download completed callback is invoked */
                    PluginTestingFramework.updatePackagePath = path.join(PluginTestingFramework.templatePath, "config.xml");

                    PluginTestingFramework.testMessageCallback = (requestBody: any) => {
                        try {
                            assert.equal(ServerUtil.TestMessage.DOWNLOAD_SUCCEEDED, requestBody.message);
                            done();
                        } catch (e) {
                            done(e);
                        }
                    };

                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                }, false),
            
            new PluginTestingFramework.TestBuilderIt("remotePackage.download.error",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    /* pass an invalid path */
                    PluginTestingFramework.updatePackagePath = path.join(PluginTestingFramework.templatePath, "invalid_path.zip");

                    PluginTestingFramework.testMessageCallback = (requestBody: any) => {
                        try {
                            assert.equal(ServerUtil.TestMessage.DOWNLOAD_ERROR, requestBody.message);
                            done();
                        } catch (e) {
                            done(e);
                        }
                    };

                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                }, false)
        ], ScenarioDownloadUpdate),
        
    new PluginTestingFramework.TestBuilderDescribe("#localPackage.install",
    
        [
            new PluginTestingFramework.TestBuilderIt("localPackage.install.unzip.error",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    /* pass an invalid zip file, here, config.xml */
                    PluginTestingFramework.updatePackagePath = path.join(PluginTestingFramework.templatePath, "config.xml");

                    PluginTestingFramework.testMessageCallback = (requestBody: any) => {
                        try {
                            assert.equal(ServerUtil.TestMessage.INSTALL_ERROR, requestBody.message);
                            done();
                        } catch (e) {
                            done(e);
                        }
                    };

                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                }, false),
            
            new PluginTestingFramework.TestBuilderIt("localPackage.install.handlesDiff.againstBinary",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    /* create an update */
                    PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateNotifyApplicationReady, "Diff Update 1")
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_INSTALLED, ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* run the app again to ensure it was not reverted */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false),
            
            new PluginTestingFramework.TestBuilderIt("localPackage.install.immediately",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    /* create an update */
                    PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateNotifyApplicationReady, "Update 1")
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_INSTALLED, ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* run the app again to ensure it was not reverted */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false)
        ], ScenarioInstall),
        
    new PluginTestingFramework.TestBuilderDescribe("#localPackage.install.revert",
    
        [
            new PluginTestingFramework.TestBuilderIt("localPackage.install.revert.dorevert",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    /* create an update */
                    PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateDeviceReady, "Update 1 (bad update)")
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_INSTALLED, ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* run the app again to ensure it was reverted */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_FAILED_PREVIOUSLY], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* create a second failed update */
                            console.log("Creating a second failed update.");
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_INSTALLED, ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* run the app again to ensure it was reverted */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_FAILED_PREVIOUSLY], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false),
            
            new PluginTestingFramework.TestBuilderIt("localPackage.install.revert.norevert",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    /* create an update */
                    PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateNotifyApplicationReady, "Update 1 (good update)")
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_INSTALLED, ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* run the app again to ensure it was not reverted */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false)
        ], ScenarioInstallWithRevert),
    
    new PluginTestingFramework.TestBuilderDescribe("#localPackage.installOnNextResume",
    
        [
            new PluginTestingFramework.TestBuilderIt("localPackage.installOnNextResume.dorevert",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateDeviceReady, "Update 1")
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_INSTALLED], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* resume the application */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            projectManager.resumeApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* restart to revert it */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_FAILED_PREVIOUSLY], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, true),
            
            new PluginTestingFramework.TestBuilderIt("localPackage.installOnNextResume.norevert",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    /* create an update */
                    PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateNotifyApplicationReady, "Update 1 (good update)")
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_INSTALLED], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* resume the application */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS], deferred);
                            projectManager.resumeApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* restart to make sure it did not revert */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, true)
        ], ScenarioInstallOnResumeWithRevert),
        
    new PluginTestingFramework.TestBuilderDescribe("localPackage installOnNextRestart",
    
        [
            new PluginTestingFramework.TestBuilderIt("localPackage.installOnNextRestart.dorevert",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateDeviceReady, "Update 1")
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_INSTALLED], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* restart the application */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            console.log("Update hash: " + PluginTestingFramework.updateResponse.updateInfo.packageHash);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* restart the application */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_FAILED_PREVIOUSLY], deferred);
                            console.log("Update hash: " + PluginTestingFramework.updateResponse.updateInfo.packageHash);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false),
            
            new PluginTestingFramework.TestBuilderIt("localPackage.installOnNextRestart.norevert",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    /* create an update */
                    PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateNotifyApplicationReady, "Update 1 (good update)")
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_INSTALLED], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* "resume" the application - run it again */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* run again to make sure it did not revert */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, true),
            
            new PluginTestingFramework.TestBuilderIt("localPackage.installOnNextRestart.revertToPrevious",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    /* create an update */
                    PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateNotifyApplicationReadyConditional, "Update 1 (good update)")
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.UPDATE_INSTALLED], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* run good update, set up another (bad) update */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS, ServerUtil.TestMessage.UPDATE_INSTALLED], deferred);
                            PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };
                            PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateDeviceReady, "Update 2 (bad update)")
                                .then(() => { return projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform); });
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* run the bad update without calling notifyApplicationReady */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* run the good update and don't call notifyApplicationReady - it should not revert */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageResponse = ServerUtil.TestMessageResponse.SKIP_NOTIFY_APPLICATION_READY;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.SKIPPED_NOTIFY_APPLICATION_READY], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* run the application again */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageResponse = undefined;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS, ServerUtil.TestMessage.UPDATE_FAILED_PREVIOUSLY], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false)
        ], ScenarioInstallOnRestartWithRevert),
        
    new PluginTestingFramework.TestBuilderDescribe("#codePush.restartApplication",
    
        [
            new PluginTestingFramework.TestBuilderIt("codePush.restartApplication.checkPackages",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateNotifyApplicationReady, "Update 1")
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.PENDING_PACKAGE, [null]),
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.CURRENT_PACKAGE, [null]),
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_DOWNLOADING_PACKAGE]),
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_INSTALLING_UPDATE]),
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED]),
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.PENDING_PACKAGE, [PluginTestingFramework.updateResponse.updateInfo.packageHash]),
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.CURRENT_PACKAGE, [null]),
                                ServerUtil.TestMessage.RESTART_SUCCEEDED,
                                ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE,
                                ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS
                            ], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform);
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            /* restart the application */
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE, ServerUtil.TestMessage.NOTIFY_APP_READY_SUCCESS
                            ], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform);
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, true)
        ], ScenarioRestart),
        
    new PluginTestingFramework.TestBuilderDescribe("#window.codePush.sync",
        [
            // We test the functionality with sync twice--first, with sync only called once,
            // then, with sync called again while the first sync is still running.
            new PluginTestingFramework.TestBuilderDescribe("#window.codePush.sync 1x",
                [
                    // Tests where sync is called just once
                    new PluginTestingFramework.TestBuilderIt("window.codePush.sync.noupdate",
                        (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                            var noUpdateResponse = PluginTestingFramework.createDefaultResponse();
                            noUpdateResponse.isAvailable = false;
                            noUpdateResponse.appVersion = "0.0.1";
                            PluginTestingFramework.updateResponse = { updateInfo: noUpdateResponse };

                            Q({})
                                .then<void>(p => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UP_TO_DATE])],
                                        deferred);
                                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .done(() => { done(); }, () => { done(); });
                        }, false),
                    
                    new PluginTestingFramework.TestBuilderIt("window.codePush.sync.checkerror",
                        (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                            PluginTestingFramework.updateResponse = "invalid {{ json";

                            Q({})
                                .then<void>(p => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_ERROR])],
                                        deferred);
                                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .done(() => { done(); }, () => { done(); });
                        }, false),
                    
                    new PluginTestingFramework.TestBuilderIt("window.codePush.sync.downloaderror",
                        (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                            var invalidUrlResponse = PluginTestingFramework.createMockResponse();
                            invalidUrlResponse.downloadURL = path.join(PluginTestingFramework.templatePath, "invalid_path.zip");
                            PluginTestingFramework.updateResponse = { updateInfo: invalidUrlResponse };

                            Q({})
                                .then<void>(p => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_DOWNLOADING_PACKAGE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_ERROR])],
                                        deferred);
                                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .done(() => { done(); }, () => { done(); });
                        }, false),
                    
                    new PluginTestingFramework.TestBuilderIt("window.codePush.sync.dorevert",
                        (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                            PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };
                        
                            /* create an update */
                            PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateDeviceReady, "Update 1 (bad update)")
                                .then<void>((updatePath: string) => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.updatePackagePath = updatePath;
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_DOWNLOADING_PACKAGE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_INSTALLING_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED]),
                                        ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .then<void>(() => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UP_TO_DATE])], deferred);
                                    projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .done(() => { done(); }, () => { done(); });
                        }, false),
                    
                    new PluginTestingFramework.TestBuilderIt("window.codePush.sync.update",
                        (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                            PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                            /* create an update */
                            PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateSync, "Update 1 (good update)")
                                .then<void>((updatePath: string) => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.updatePackagePath = updatePath;
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_DOWNLOADING_PACKAGE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_INSTALLING_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED]),
                                        // the update is immediate so the update will install
                                        ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .then<void>(() => {
                                    // restart the app and make sure it didn't roll out!
                                    var deferred = Q.defer<void>();
                                    var noUpdateResponse = PluginTestingFramework.createDefaultResponse();
                                    noUpdateResponse.isAvailable = false;
                                    noUpdateResponse.appVersion = "0.0.1";
                                    PluginTestingFramework.updateResponse = { updateInfo: noUpdateResponse };
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                                    projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .done(() => { done(); }, () => { done(); });
                        }, false)
                    
                ], ScenarioSync1x),
                
            new PluginTestingFramework.TestBuilderDescribe("#window.codePush.sync 2x",
                [
                    // Tests where sync is called again before the first sync finishes
                    new PluginTestingFramework.TestBuilderIt("window.codePush.sync.2x.noupdate",
                        (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                            var noUpdateResponse = PluginTestingFramework.createDefaultResponse();
                            noUpdateResponse.isAvailable = false;
                            noUpdateResponse.appVersion = "0.0.1";
                            PluginTestingFramework.updateResponse = { updateInfo: noUpdateResponse };

                            Q({})
                                .then<void>(p => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_IN_PROGRESS]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UP_TO_DATE])],
                                        deferred);
                                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .done(() => { done(); }, () => { done(); });
                        }, false),
                    
                    new PluginTestingFramework.TestBuilderIt("window.codePush.sync.2x.checkerror",
                        (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                            PluginTestingFramework.updateResponse = "invalid {{ json";

                            Q({})
                                .then<void>(p => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_IN_PROGRESS]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_ERROR])],
                                        deferred);
                                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .done(() => { done(); }, () => { done(); });
                        }, false),
                    
                    new PluginTestingFramework.TestBuilderIt("window.codePush.sync.2x.downloaderror",
                        (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                            var invalidUrlResponse = PluginTestingFramework.createMockResponse();
                            invalidUrlResponse.downloadURL = path.join(PluginTestingFramework.templatePath, "invalid_path.zip");
                            PluginTestingFramework.updateResponse = { updateInfo: invalidUrlResponse };

                            Q({})
                                .then<void>(p => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_IN_PROGRESS]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_DOWNLOADING_PACKAGE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_ERROR])],
                                        deferred);
                                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .done(() => { done(); }, () => { done(); });
                        }, false),
                    
                    new PluginTestingFramework.TestBuilderIt("window.codePush.sync.2x.dorevert",
                        (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                            PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };
                    
                            /* create an update */
                            PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateDeviceReady, "Update 1 (bad update)")
                                .then<void>((updatePath: string) => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.updatePackagePath = updatePath;
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_IN_PROGRESS]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_DOWNLOADING_PACKAGE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_INSTALLING_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED]),
                                        ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE],
                                        deferred);
                                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .then<void>(() => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_IN_PROGRESS]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UP_TO_DATE])],
                                        deferred);
                                    projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .done(() => { done(); }, () => { done(); });
                        }, false),
                    
                    new PluginTestingFramework.TestBuilderIt("window.codePush.sync.2x.update",
                        (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                            PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                            /* create an update */
                            PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateSync2x, "Update 1 (good update)")
                                .then<void>((updatePath: string) => {
                                    var deferred = Q.defer<void>();
                                    PluginTestingFramework.updatePackagePath = updatePath;
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_CHECKING_FOR_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_IN_PROGRESS]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_DOWNLOADING_PACKAGE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_INSTALLING_UPDATE]),
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED]),
                                        // the update is immediate so the update will install
                                        ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE,
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_IN_PROGRESS])],
                                        deferred);
                                    projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .then<void>(() => {
                                    // restart the app and make sure it didn't roll out!
                                    var deferred = Q.defer<void>();
                                    var noUpdateResponse = PluginTestingFramework.createDefaultResponse();
                                    noUpdateResponse.isAvailable = false;
                                    noUpdateResponse.appVersion = "0.0.1";
                                    PluginTestingFramework.updateResponse = { updateInfo: noUpdateResponse };
                                    PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                        ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE,
                                        new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_IN_PROGRESS])],
                                        deferred);
                                    projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform).done();
                                    return deferred.promise;
                                })
                                .done(() => { done(); }, () => { done(); });
                        }, true)
                ], ScenarioSync2x)
        ]),
    
    new PluginTestingFramework.TestBuilderDescribe("#window.codePush.sync minimum background duration tests",
    
        [
            new PluginTestingFramework.TestBuilderIt("defaults to no minimum",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    PluginTestingFramework.setupScenario(projectManager, targetPlatform, ScenarioSyncResume).then<string>(() => {
                            return PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateSync, "Update 1 (good update)");
                        })
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED])], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            var deferred = Q.defer<void>();
                            var noUpdateResponse = PluginTestingFramework.createDefaultResponse();
                            noUpdateResponse.isAvailable = false;
                            noUpdateResponse.appVersion = "0.0.1";
                            PluginTestingFramework.updateResponse = { updateInfo: noUpdateResponse };
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            projectManager.resumeApplication(PluginTestingFramework.TestNamespace, targetPlatform).done();
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false),
            
            new PluginTestingFramework.TestBuilderIt("min background duration 5s",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    PluginTestingFramework.setupScenario(projectManager, targetPlatform, ScenarioSyncResumeDelay).then<string>(() => {
                            return PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateSync, "Update 1 (good update)");
                        })
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED])], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                            return deferred.promise;
                        })
                        .then<string>(() => {
                            var noUpdateResponse = PluginTestingFramework.createDefaultResponse();
                            noUpdateResponse.isAvailable = false;
                            noUpdateResponse.appVersion = "0.0.1";
                            PluginTestingFramework.updateResponse = { updateInfo: noUpdateResponse };
                            return projectManager.resumeApplication(PluginTestingFramework.TestNamespace, targetPlatform, 3 * 1000);
                        })
                        .then<void>(() => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            projectManager.resumeApplication(PluginTestingFramework.TestNamespace, targetPlatform, 6 * 1000).done();
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false),
                
            new PluginTestingFramework.TestBuilderIt("has no effect on restart",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    PluginTestingFramework.setupScenario(projectManager, targetPlatform, ScenarioSyncRestartDelay).then<string>(() => {
                            return PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateSync, "Update 1 (good update)");
                        })
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED])], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            var deferred = Q.defer<void>();
                            var noUpdateResponse = PluginTestingFramework.createDefaultResponse();
                            noUpdateResponse.isAvailable = false;
                            noUpdateResponse.appVersion = "0.0.1";
                            PluginTestingFramework.updateResponse = { updateInfo: noUpdateResponse };
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            projectManager.restartApplication(PluginTestingFramework.TestNamespace, targetPlatform).done();
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false)
        ]),
        
    new PluginTestingFramework.TestBuilderDescribe("#window.codePush.sync mandatory install mode tests",
    
        [
            new PluginTestingFramework.TestBuilderIt("defaults to IMMEDIATE",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform, true) };

                    PluginTestingFramework.setupScenario(projectManager, targetPlatform, ScenarioSyncMandatoryDefault).then<string>(() => {
                            return PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateDeviceReady, "Update 1 (good update)");
                        })
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED]),
                                ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false),
                
            new PluginTestingFramework.TestBuilderIt("works correctly when update is mandatory and mandatory install mode is specified",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform, true) };

                    PluginTestingFramework.setupScenario(projectManager, targetPlatform, ScenarioSyncMandatoryResume).then<string>(() => {
                            return PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateDeviceReady, "Update 1 (good update)");
                        })
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED])], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                            return deferred.promise;
                        })
                        .then<void>(() => {
                            var deferred = Q.defer<void>();
                            var noUpdateResponse = PluginTestingFramework.createDefaultResponse();
                            noUpdateResponse.isAvailable = false;
                            noUpdateResponse.appVersion = "0.0.1";
                            PluginTestingFramework.updateResponse = { updateInfo: noUpdateResponse };
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            projectManager.resumeApplication(PluginTestingFramework.TestNamespace, targetPlatform, 5 * 1000).done();
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false),
                
            new PluginTestingFramework.TestBuilderIt("has no effect on updates that are not mandatory",
                (projectManager: ProjectManager, targetPlatform: Platform.IPlatform, done: MochaDone) => {
                    PluginTestingFramework.updateResponse = { updateInfo: PluginTestingFramework.getMockResponse(targetPlatform) };

                    PluginTestingFramework.setupScenario(projectManager, targetPlatform, ScenarioSyncMandatoryRestart).then<string>(() => {
                            return PluginTestingFramework.createUpdate(projectManager, targetPlatform, UpdateDeviceReady, "Update 1 (good update)");
                        })
                        .then<void>((updatePath: string) => {
                            var deferred = Q.defer<void>();
                            PluginTestingFramework.updatePackagePath = updatePath;
                            PluginTestingFramework.testMessageCallback = PluginTestingFramework.verifyMessages([
                                new ServerUtil.AppMessage(ServerUtil.TestMessage.SYNC_STATUS, [ServerUtil.TestMessage.SYNC_UPDATE_INSTALLED]),
                                ServerUtil.TestMessage.DEVICE_READY_AFTER_UPDATE], deferred);
                            projectManager.runPlatform(PluginTestingFramework.testRunDirectory, targetPlatform).done();
                            return deferred.promise;
                        })
                        .done(() => { done(); }, () => { done(); });
                }, false)
        ])
];

// Create tests.
PluginTestingFramework.initializeTests(new CordovaProjectManager(), testBuilderDescribes);