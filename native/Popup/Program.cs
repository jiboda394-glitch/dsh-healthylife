using System;
using System.IO;
using System.Text.Json;
using System.Windows;

namespace HealthyLife.Popup
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            PopupOptions options;
            try
            {
                options = PopupOptions.Parse(args);
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "健康生活", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            var application = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            var window = new PopupWindow(options);
            application.Run(window);
        }
    }

    internal sealed class PopupOptions
    {
        public string Api = "http://127.0.0.1:0/healthylife/api";
        public string Phase = "countdown";
        public long Deadline = 0;
        public long TargetAt = 0;
        public bool Preview = false;
        public string WindowDay = "";
        public int CountdownSeconds = 30;
        public int MinutesLeft = 10;
        public int QuotaLeft = 0;
        public string WindowStart = "01:00";
        public string WindowEnd = "05:00";
        public bool Dark = true;

        public static PopupOptions Parse(string[] args)
        {
            var options = new PopupOptions();
            string file = null;
            for (var index = 0; index < args.Length; index++)
            {
                if (args[index] == "--file" && index + 1 < args.Length) file = args[++index];
            }

            if (file != null && File.Exists(file))
            {
                using var document = JsonDocument.Parse(File.ReadAllText(file));
                var root = document.RootElement;
                options.Api = ReadString(root, "api", options.Api);
                options.Phase = ReadString(root, "phase", options.Phase);
                options.Deadline = ReadLong(root, "deadline", options.Deadline);
                options.TargetAt = ReadLong(root, "targetAt", options.TargetAt);
                options.Preview = ReadBool(root, "preview", options.Preview);
                options.WindowDay = ReadString(root, "windowDay", options.WindowDay);
                options.CountdownSeconds = (int)ReadLong(root, "countdownSeconds", options.CountdownSeconds);
                options.MinutesLeft = (int)ReadLong(root, "minutesLeft", options.MinutesLeft);
                options.QuotaLeft = (int)ReadLong(root, "quotaLeft", options.QuotaLeft);
                options.WindowStart = ReadString(root, "windowStart", options.WindowStart);
                options.WindowEnd = ReadString(root, "windowEnd", options.WindowEnd);
                options.Dark = ReadBool(root, "dark", options.Dark);
            }

            for (var index = 0; index < args.Length; index++)
            {
                var name = args[index];
                var value = index + 1 < args.Length ? args[index + 1] : null;
                if (value == null) continue;
                switch (name)
                {
                    case "--api": options.Api = value; index++; break;
                    case "--phase": options.Phase = value; index++; break;
                    case "--deadline": options.Deadline = long.TryParse(value, out var deadline) ? deadline : options.Deadline; index++; break;
                    case "--target": options.TargetAt = long.TryParse(value, out var targetAt) ? targetAt : options.TargetAt; index++; break;
                    case "--preview": options.Preview = value != "false"; index++; break;
                    case "--day": options.WindowDay = value; index++; break;
                    case "--countdown": options.CountdownSeconds = int.TryParse(value, out var countdown) ? countdown : options.CountdownSeconds; index++; break;
                    case "--minutes": options.MinutesLeft = int.TryParse(value, out var minutes) ? minutes : options.MinutesLeft; index++; break;
                    case "--quota": options.QuotaLeft = int.TryParse(value, out var quota) ? quota : options.QuotaLeft; index++; break;
                    case "--start": options.WindowStart = value; index++; break;
                    case "--end": options.WindowEnd = value; index++; break;
                    case "--theme": options.Dark = value != "light"; index++; break;
                }
            }

            if (options.Api.EndsWith("/")) options.Api = options.Api.Substring(0, options.Api.Length - 1);
            return options;
        }

        private static string ReadString(JsonElement root, string name, string fallback)
            => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : fallback;

        private static long ReadLong(JsonElement root, string name, long fallback)
            => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt64() : fallback;

        private static bool ReadBool(JsonElement root, string name, bool fallback)
            => root.TryGetProperty(name, out var value) && (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False)
                ? value.GetBoolean()
                : fallback;
    }
}
