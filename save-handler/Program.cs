using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.Serialization.Formatters.Binary;
using System.Runtime.Serialization;
using System.Text;

class Program
{
    static void Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("Usage: SaveHandler.exe <read|write> <savePath> <gameAssemblyDir> [jsonData]");
            Environment.Exit(1);
        }

        string command = args[0];
        string savePath = args[1];
        string gameAssemblyDir = args[2];

        try
        {
            if (command == "read")
            {
                Read(savePath, gameAssemblyDir);
            }
            else if (command == "write")
            {
                string jsonData = args.Length > 3 ? args[3] : Console.In.ReadToEnd();
                Write(savePath, gameAssemblyDir, jsonData);
            }
            else
            {
                Console.Error.WriteLine("Unknown command: " + command);
                Environment.Exit(1);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERROR: " + ex.Message);
            Console.Error.WriteLine(ex.StackTrace);
            Environment.Exit(1);
        }
    }

    static void SetupAssemblyResolver(string managedDir)
    {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) =>
        {
            string name = new AssemblyName(args.Name).Name;
            string dllPath = Path.Combine(managedDir, name + ".dll");
            if (File.Exists(dllPath))
                return Assembly.LoadFrom(dllPath);
            return null;
        };
    }

    static string FindAssemblyPath(string gameAssemblyDir)
    {
        string[] possiblePaths = new[]
        {
            Path.Combine(gameAssemblyDir, "Assembly-CSharp.dll"),
            Path.Combine(gameAssemblyDir, "Managed", "Assembly-CSharp.dll"),
            Path.Combine(gameAssemblyDir, "WhatTheDub_Data", "Managed", "Assembly-CSharp.dll"),
        };

        foreach (string p in possiblePaths)
        {
            if (File.Exists(p))
                return p;
        }
        throw new FileNotFoundException("Cannot find Assembly-CSharp.dll. Searched:\n" + string.Join("\n", possiblePaths));
    }

    static void Read(string savePath, string gameAssemblyDir)
    {
        string asmPath = FindAssemblyPath(gameAssemblyDir);
        string asmDir = Path.GetDirectoryName(asmPath);
        SetupAssemblyResolver(asmDir);
        Assembly gameAsm = Assembly.LoadFrom(asmPath);
        BinaryFormatter formatter = new BinaryFormatter();
        formatter.Binder = new GameSerializationBinder(gameAsm);

        object data;
        using (FileStream fs = new FileStream(savePath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            data = formatter.Deserialize(fs);
        }

        Type wtdType = data.GetType();
        object settings = wtdType.GetField("settings").GetValue(data);
        Type settingsType = settings.GetType();
        object disabledPacks = settingsType.GetField("disabledClipPacks").GetValue(settings);
        IList<string> disabledList = (IList<string>)disabledPacks;

        FieldInfo viewedClipsField = wtdType.GetField("lifetimeViewedClips");
        HashSet<string> clipWorkshopIds = new HashSet<string>();
        HashSet<string> knownPackIds = new HashSet<string>();
        int totalClipEntries = 0;
        int workshopPrefixed = 0;
        int parseFailures = 0;

        if (viewedClipsField != null)
        {
            object viewedClips = viewedClipsField.GetValue(data);
            ISet<string> viewedSet = viewedClips as ISet<string>;
            if (viewedSet != null)
            {
                foreach (string clip in viewedSet)
                {
                    totalClipEntries++;
                    if (clip.StartsWith("workshop:"))
                    {
                        workshopPrefixed++;
                        int secondColon = clip.IndexOf(':', 10);
                        if (secondColon > 10)
                        {
                            string wid = clip.Substring(10, secondColon - 10);
                            if (wid.Length > 0 && wid[0] >= '0' && wid[0] <= '9')
                            {
                                clipWorkshopIds.Add(wid);
                            }
                            else
                            {
                                parseFailures++;
                            }
                        }
                        else
                        {
                            parseFailures++;
                        }
                    }
                }
            }
        }

        foreach (string id in disabledList)
        {
            if (id != "default" && id.Length >= 6 && id[0] >= '0' && id[0] <= '9')
                knownPackIds.Add(id);
        }

        HashSet<string> allPackIds = new HashSet<string>(clipWorkshopIds);
        foreach (string id in knownPackIds)
            allPackIds.Add(id);

        StringBuilder sb = new StringBuilder();
        sb.Append("{\"disabledClipPacks\":[");
        for (int i = 0; i < disabledList.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append('"').Append(EscapeJson(disabledList[i])).Append('"');
        }
        sb.Append("],\"viewedPackIds\":[");
        int j = 0;
        foreach (string wid in allPackIds)
        {
            if (j > 0) sb.Append(',');
            sb.Append('"').Append(wid).Append('"');
            j++;
        }
        sb.Append("],\"_stats\":{");
        sb.Append("\"totalClipEntries\":").Append(totalClipEntries);
        sb.Append(",\"workshopPrefixed\":").Append(workshopPrefixed);
        sb.Append(",\"parseFailures\":").Append(parseFailures);
        sb.Append(",\"idsFromClips\":").Append(clipWorkshopIds.Count);
        sb.Append(",\"idsFromDisabled\":").Append(knownPackIds.Count);
        sb.Append(",\"totalUniqueIds\":").Append(allPackIds.Count);
        sb.Append("}");
        sb.Append("}");
        Console.WriteLine(sb.ToString());
    }

    static void Write(string savePath, string gameAssemblyDir, string jsonData)
    {
        List<string> newDisabled = new List<string>();
        int start = jsonData.IndexOf("\"disabledClipPacks\"", StringComparison.Ordinal);
        if (start < 0)
            throw new Exception("Missing disabledClipPacks in JSON");

        int arrayStart = jsonData.IndexOf('[', start);
        int arrayEnd = jsonData.IndexOf(']', arrayStart);
        if (arrayStart < 0 || arrayEnd < 0)
            throw new Exception("Invalid disabledClipPacks array in JSON");

        string arrayStr = jsonData.Substring(arrayStart + 1, arrayEnd - arrayStart - 1).Trim();
        if (arrayStr.Length > 0)
        {
            string[] rawItems = arrayStr.Split(new[] { "\",\"" }, StringSplitOptions.None);
            foreach (string rawItem in rawItems)
            {
                string cleaned = rawItem.Trim().Trim('"').Trim();
                if (!string.IsNullOrEmpty(cleaned))
                    newDisabled.Add(cleaned);
            }
        }

        string asmPath = FindAssemblyPath(gameAssemblyDir);
        string asmDir = Path.GetDirectoryName(asmPath);
        SetupAssemblyResolver(asmDir);
        Assembly gameAsm = Assembly.LoadFrom(asmPath);
        BinaryFormatter formatter = new BinaryFormatter();
        formatter.Binder = new GameSerializationBinder(gameAsm);

        object data;
        using (FileStream fs = new FileStream(savePath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            data = formatter.Deserialize(fs);
        }

        Type wtdType = data.GetType();
        object settings = wtdType.GetField("settings").GetValue(data);
        Type settingsType = settings.GetType();
        FieldInfo disabledField = settingsType.GetField("disabledClipPacks");
        object disabledList = disabledField.GetValue(settings);

        dynamic list = disabledList;
        list.Clear();
        foreach (string id in newDisabled)
        {
            list.Add(id);
        }

        if (File.Exists(savePath))
        {
            string backupPath = savePath + ".bak";
            File.Copy(savePath, backupPath, true);
        }

        using (FileStream fs = new FileStream(savePath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            formatter.Serialize(fs, data);
        }

        Console.WriteLine("{\"success\":true}");
    }

    static string EscapeJson(string s)
    {
        if (string.IsNullOrEmpty(s)) return s ?? "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}

class GameSerializationBinder : SerializationBinder
{
    private Assembly _gameAsm;

    public GameSerializationBinder(Assembly gameAsm)
    {
        _gameAsm = gameAsm;
    }

    public override Type BindToType(string assemblyName, string typeName)
    {
        if (assemblyName != null && assemblyName.Contains("Assembly-CSharp"))
        {
            Type t = _gameAsm.GetType(typeName);
            if (t != null) return t;
        }
        if (typeName != null && (typeName.Contains("Wtd") || typeName.Contains("SaveData") || typeName.Contains("Achievement") || typeName.Contains("Profanity")))
        {
            Type t = _gameAsm.GetType(typeName);
            if (t != null) return t;
        }
        try
        {
            return Type.GetType(string.Format("{0}, {1}", typeName, assemblyName), true);
        }
        catch (TypeLoadException)
        {
            // Unity Mono has internal types not present in .NET Framework mscorlib.
            // Try proxy stubs from this assembly.
            Type stub = Type.GetType(typeName, false);
            if (stub != null) return stub;
            throw;
        }
    }

    public override void BindToName(Type serializedType, out string assemblyName, out string typeName)
    {
        // Force our stub types to serialize as mscorlib types,
        // matching the game's expectations for Unity Mono internal types.
        if (serializedType.FullName == "System.Collections.Generic.InternalStringComparer")
        {
            assemblyName = "mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089";
            typeName = "System.Collections.Generic.InternalStringComparer";
            return;
        }

        if (serializedType.IsGenericType &&
            serializedType.GetGenericTypeDefinition().FullName == "System.Collections.Generic.EnumEqualityComparer`1")
        {
            assemblyName = "mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089";
            typeName = serializedType.FullName;
            return;
        }

        assemblyName = serializedType.Assembly.FullName;
        typeName = serializedType.FullName;
    }
}

// Stub types to replace Unity Mono internal types during BinaryFormatter deserialization.
// These must match the serialization layout of Unity's versions.
namespace System.Collections.Generic
{
    [Serializable]
    internal sealed class InternalStringComparer : EqualityComparer<string>
    {
        public override bool Equals(string x, string y) { return string.Equals(x, y); }
        public override int GetHashCode(string obj) { return obj != null ? obj.GetHashCode() : 0; }
    }

    [Serializable]
    internal sealed class EnumEqualityComparer<T> : EqualityComparer<T> where T : struct
    {
        public override bool Equals(T x, T y) { return EqualityComparer<T>.Default.Equals(x, y); }
        public override int GetHashCode(T obj) { return obj.GetHashCode(); }
    }
}
